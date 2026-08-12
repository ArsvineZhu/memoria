import type { EmbeddingVector } from "../../types/common.js";
import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";
import type { VectorStoreContract } from "../../types/vector.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";
import { at } from "../../utils/numerical.js";

// Canonical tag vector index name.
const TAG_INDEX_NAME = "tag_vectors";

/**
 * Writes chunk and tag vectors into the vector store after the
 * MetadataWriterStage has persisted the metadata rows.
 *
 * Writes the tag vector index for the MemoryEngine ingestion stage:
 *  - stale chunk vectors (removedChunkIds) are deleted BEFORE new ones are
 *    added so a re-embedded file never leaves orphans in the index
 *  - chunk vectors go to the index named after the space
 *  - tag vectors go to the shared 'tag_vectors' index
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

    const fallbackIndexName =
      typeof info.space === "string" && info.space ? info.space : "Root";
    const currentIndexName =
      typeof info.currentIndexName === "string" && info.currentIndexName
        ? info.currentIndexName
        : fallbackIndexName;
    const previousIndexName =
      typeof info.previousIndexName === "string" && info.previousIndexName
        ? info.previousIndexName
        : currentIndexName;

    const chunkEntries = Array.isArray(info.chunkEntries) ? info.chunkEntries : [];
    const chunkIds = Array.isArray(info.chunkIds) ? info.chunkIds : [];
    const removedChunkIds = Array.isArray(info.removedChunkIds)
      ? info.removedChunkIds
      : [];

    // 1. Remove stale vectors before adding new ones.
    for (const id of removedChunkIds) {
      await this._safeRemove(vectorStore, previousIndexName, id);
    }
    const orphanedTagIds = Array.isArray(info.orphanedTagIds)
      ? info.orphanedTagIds
      : [];
    for (const id of orphanedTagIds) {
      await this._safeRemove(vectorStore, TAG_INDEX_NAME, Number(id));
    }

    // 2. Add chunk vectors to the space index.
    const chunkCount = Math.min(chunkEntries.length, chunkIds.length);
    for (let i = 0; i < chunkCount; i++) {
      const chunkId = at(chunkIds, i, "chunk ids");
      const chunkEntry = at(chunkEntries, i, "chunk entries");
      await this._upsertAdd(vectorStore, currentIndexName, chunkId, chunkEntry.vector);
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
      if (removedChunkIds.length > 0) {
        vectorStore.scheduleIndexSave(previousIndexName);
      }
      if (chunkCount > 0) {
        vectorStore.scheduleIndexSave(currentIndexName);
      }
      if (
        (tagCount > 0 || orphanedTagIds.length > 0) &&
        ctx.config?.persistTagVectorIndex !== false
      ) {
        vectorStore.scheduleIndexSave(TAG_INDEX_NAME);
      }
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
        try {
          await this._safeRemove(vectorStore, indexName, id);
          await vectorStore.add(indexName, id, vector);
        } catch (retryError) {
          throw asMemoriaError(
            retryError,
            "vector_backend",
            "Vector store failed while replacing a vector.",
            { retryable: true },
          );
        }
        return;
      }
      throw asMemoriaError(
        e,
        "vector_backend",
        "Vector store failed while writing a vector.",
        { retryable: true },
      );
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
      throw asMemoriaError(
        e,
        "vector_backend",
        "Vector store failed while removing a vector.",
        { retryable: true },
      );
    }
  }
}

export default VectorIndexerStage;
