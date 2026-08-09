import type {
  EmbeddingVector,
  PipelineContextLike,
  PipelineData,
  VectorStoreContract,
} from "../../types.js";

import Stage from "../../core/stage.js";
import { at } from "../../utils/numerical.js";

// Global tag vector index name (mirror of KnowledgeBaseManager.tagIndex).
const TAG_INDEX_NAME = "global_tags";

/**
 * Writes chunk and tag vectors into the vector store after the
 * MetadataWriterStage has persisted the metadata rows.
 *
 * Mirrors the KnowledgeBaseManager._flushBatch index write section:
 *  - stale chunk vectors (removedChunkIds) are deleted BEFORE new ones are
 *    added so a re-embedded file never leaves orphans in the index
 *  - chunk vectors go to the index named after the diary
 *  - tag vectors go to the shared 'global_tags' index
 *  - duplicate-key collisions are resolved via remove-then-add upsert
 *  - scheduleIndexSave is triggered for each touched index afterwards
 *
 * Config (ctx.config): none required.
 */
class VectorIndexerStage extends Stage {
  constructor() {
    super();
    this.name = "vectorIndexer";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "vectorIndexWritten"> & {
      vectorIndexWritten: number;
      vectorStoreMissing?: boolean;
    }
  > {
    const info = input || {};
    const vectorStore = ctx.vectorStore;

    if (!vectorStore) {
      return { ...info, vectorIndexWritten: 0, vectorStoreMissing: true };
    }

    const indexName =
      typeof info.diaryName === "string" && info.diaryName ? info.diaryName : "Root";

    const chunkEntries = Array.isArray(info.chunkEntries) ? info.chunkEntries : [];
    const chunkIds = Array.isArray(info.chunkIds) ? info.chunkIds : [];
    const removedChunkIds = Array.isArray(info.removedChunkIds)
      ? info.removedChunkIds
      : [];

    // 1. Remove stale vectors before adding new ones.
    for (const id of removedChunkIds) {
      await this._safeRemove(vectorStore, indexName, id);
    }

    // 2. Add chunk vectors to the diary index.
    const chunkCount = Math.min(chunkEntries.length, chunkIds.length);
    for (let i = 0; i < chunkCount; i++) {
      const chunkId = at(chunkIds, i, "chunk ids");
      const chunkEntry = at(chunkEntries, i, "chunk entries");
      await this._upsertAdd(vectorStore, indexName, chunkId, chunkEntry.vector);
    }

    // 3. Add tag vectors to the shared global tag index.
    const tagEntries = Array.isArray(info.tagEntries) ? info.tagEntries : [];
    const tagIds = Array.isArray(info.tagIds) ? info.tagIds : [];
    const tagCount = Math.min(tagEntries.length, tagIds.length);
    for (let i = 0; i < tagCount; i++) {
      const tagEntry = at(tagEntries, i, "tag entries");
      const vector = tagEntry.vector;
      if (vector == null) continue;
      await this._upsertAdd(
        vectorStore,
        TAG_INDEX_NAME,
        at(tagIds, i, "tag ids"),
        vector,
      );
    }

    // 4. Schedule persistence for both touched indices.
    if (typeof vectorStore.scheduleIndexSave === "function") {
      vectorStore.scheduleIndexSave(indexName);
      vectorStore.scheduleIndexSave(TAG_INDEX_NAME);
    }

    return { ...info, vectorIndexWritten: chunkCount + tagCount };
  }

  async _upsertAdd(
    vectorStore: VectorStoreContract,
    indexName: string,
    id: number,
    vector: EmbeddingVector,
  ): Promise<void> {
    try {
      await vectorStore.add(indexName, id, vector);
    } catch (e) {
      // usearch rejects duplicate keys; mirror the original's
      // remove-then-add upsert so re-embedding stays idempotent.
      const message = e instanceof Error ? e.message : String(e);
      if (/duplicate/i.test(message)) {
        await this._safeRemove(vectorStore, indexName, id);
        await vectorStore.add(indexName, id, vector);
        return;
      }
      throw e;
    }
  }

  async _safeRemove(
    vectorStore: VectorStoreContract,
    indexName: string,
    id: number,
  ): Promise<void> {
    try {
      await vectorStore.remove(indexName, id);
    } catch (e) {
      // Deleting an already-absent vector must not fail the batch;
      // mirror ingestionPipeline's tolerance for missing ids.
      const message = e instanceof Error ? e.message : String(e);
      if (/not found|missing|absent/i.test(message)) {
        return;
      }
      throw e;
    }
  }
}

export default VectorIndexerStage;
