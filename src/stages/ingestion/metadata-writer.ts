import type {
  ChunkEntry,
  MetadataStoreContract,
  PipelineContextLike,
  PipelineData,
  TagEntry,
} from "../../types.js";

import Stage from "../../core/stage.js";
import { encodeVectorBlob } from "../../utils/vector-codec.js";
import { serializeDocumentJson } from "../../utils/logical-document.js";

// kv_store checkpoint keys (mirror of the legacy KnowledgeBaseManager
// naming convention; only written when the pipeline opts in via config).
const CHECKPOINT_KEYS = {
  memoryCheckpoint: "memory_checkpoint",
  lastFileIndexed: "last_file_indexed",
  chunkCount: "chunk_count",
  tagCount: "tag_count",
  diaryCount: "diary_count",
};

/**
 * Persists a single file's ingestion result into the metadata store:
 *  - upserts the file row (files table) and returns its id
 *  - collects ids of the previous chunk rows so the caller can clean the
 *    vector index before re-adding (mirrors ingestionPipeline._flushBatch)
 *  - inserts chunk rows (provider replaces the old ones)
 *  - upserts tag rows and rebuilds the file_tags association
 *
 * Mirrors KnowledgeBaseManager._flushBatch write section:
 * tags already stored with a vector are re-associated even when this file
 * provided no fresh embedding for them; tags without an embedding and
 * without a previously stored vector are skipped entirely.
 *
 * Config (ctx.config):
 *   - checkpoint: { enabled: true, interval: N } or `true`
 *   - checkpointInterval: bare interval (implies enabled)
 *   - when enabled, every `interval`-th file refreshes the kv_store
 *     checkpoint keys (memory_checkpoint, last_file_indexed, chunk_count,
 *     tag_count, diary_count).
 */
class MetadataWriterStage extends Stage {
  constructor() {
    super();
    this.name = "metadataWriter";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "fileId" | "chunkIds" | "tagIds" | "removedChunkIds"> & {
      fileId: number | null;
      chunkIds: number[];
      tagIds: number[];
      removedChunkIds: number[];
      previousIndexName?: string | null;
      currentIndexName?: string;
      metadataOnly?: boolean;
    }
  > {
    const fileInfo = input || {};
    const metadataStore = ctx.metadataStore;
    if (!metadataStore) throw new Error("MetadataWriterStage requires metadataStore");
    const relPath = fileInfo.relPath;
    const diaryName = fileInfo.diaryName;
    const checksum = fileInfo.checksum;
    const mtime = fileInfo.mtime;
    const size = fileInfo.size;
    if (
      typeof relPath !== "string" ||
      typeof diaryName !== "string" ||
      typeof checksum !== "string" ||
      typeof mtime !== "number" ||
      typeof size !== "number"
    )
      throw new TypeError("MetadataWriterStage requires a complete file snapshot");

    // Caller-supplied skip: neither content nor persisted file metadata changed.
    if (fileInfo.needsEmbedding === false && fileInfo.needsMetadataWrite !== true) {
      const existing = await metadataStore.getFileByPath(relPath);
      return {
        ...fileInfo,
        fileId: existing ? existing.id : null,
        chunkIds: [],
        tagIds: [],
        removedChunkIds: [],
        skipped: true,
      };
    }

    const sourceJson = serializeDocumentJson(fileInfo.documentSource, "source");
    const metadataJson = serializeDocumentJson(fileInfo.documentMetadata, "metadata");

    if (fileInfo.needsEmbedding === false && fileInfo.needsMetadataWrite === true) {
      const existing = await metadataStore.getFileByPath(relPath);
      const previousIndexName =
        existing?.diary_name || existing?.diaryName || diaryName;
      let fileId: number | null = existing?.id ?? null;
      if (typeof metadataStore.updateDocumentMetadata === "function") {
        const updated = await metadataStore.updateDocumentMetadata({
          path: relPath,
          diaryName,
          checksum,
          mtime,
          size,
          documentId: fileInfo.documentId,
          revision: fileInfo.revision,
          sourceJson,
          metadataJson,
        });
        fileId = updated.fileId;
      } else {
        fileId = await metadataStore.upsertFile({
          path: relPath,
          diaryName,
          checksum,
          mtime,
          size,
          documentId: fileInfo.documentId,
          revision: fileInfo.revision,
          sourceJson,
          metadataJson,
        });
      }
      if (fileId == null) {
        throw new Error(`Unable to persist file metadata for ${relPath}`);
      }
      return {
        ...fileInfo,
        fileId,
        chunkIds: [],
        tagIds: [],
        removedChunkIds: [],
        skipped: false,
        metadataOnly: true,
        previousIndexName,
        currentIndexName: diaryName,
      };
    }

    const chunkEntries: ChunkEntry[] = Array.isArray(fileInfo.chunkEntries)
      ? fileInfo.chunkEntries
      : [];
    const tagEntries: TagEntry[] = Array.isArray(fileInfo.tagEntries)
      ? fileInfo.tagEntries
      : [];
    const tagNames: string[] = Array.isArray(fileInfo.tags) ? fileInfo.tags : [];

    // Prepare serialized rows once for either the atomic or compatibility path.
    const chunkRows = chunkEntries.map((entry) => ({
      chunkIndex: entry.chunkIndex,
      content: entry.content,
      vector: entry.vector == null ? null : encodeVectorBlob(entry.vector),
    }));
    const tagRows = tagEntries.map((entry) => ({
      name: entry.name,
      vector: entry.vector == null ? null : encodeVectorBlob(entry.vector),
    }));
    if (typeof metadataStore.replaceDocumentState === "function") {
      const replacement = await metadataStore.replaceDocumentState({
        file: {
          path: relPath,
          diaryName,
          checksum,
          mtime,
          size,
          documentId: fileInfo.documentId,
          revision: fileInfo.revision,
          sourceJson,
          metadataJson,
        },
        chunks: chunkRows,
        tags: tagRows,
        orderedTagNames: tagNames,
      });

      await this._maybeWriteCheckpoint(
        fileInfo,
        { chunkIds: replacement.chunkIds, tagIds: replacement.tagIds },
        ctx,
      );

      return {
        ...fileInfo,
        fileId: replacement.fileId,
        chunkIds: replacement.chunkIds,
        tagIds: replacement.tagIds,
        removedChunkIds: replacement.removedChunkIds,
        previousIndexName: replacement.previousIndexName,
        currentIndexName: replacement.currentIndexName,
      };
    }

    // Compatibility path: collect old ids and use the legacy CRUD sequence
    // only when an injected store does not expose replaceDocumentState.
    let removedChunkIds: number[] = [];
    const existing = await metadataStore.getFileByPath(relPath);
    if (existing) {
      const oldChunks = await metadataStore.getChunksByFileId(existing.id);
      removedChunkIds = oldChunks.map((c) => c.id);
    }

    const fileId = await metadataStore.upsertFile({
      path: relPath,
      diaryName,
      checksum,
      mtime,
      size,
      documentId: fileInfo.documentId,
      revision: fileInfo.revision,
      sourceJson,
      metadataJson,
    });
    if (fileId === null)
      throw new Error(`Unable to persist file metadata for ${relPath}`);

    const chunkIds = await metadataStore.insertChunks(fileId, chunkRows);

    // 4. Upsert tag rows; ids are aligned with tagEntries.
    const newTagIds = await metadataStore.upsertTags(tagRows);
    const tagIdByName = new Map<string, number>();
    tagEntries.forEach((entry: TagEntry, i: number) => {
      if (newTagIds[i] != null) tagIdByName.set(entry.name, newTagIds[i]);
    });

    // 5. Rebuild the file_tags association preserving input tag order.
    //    Previously stored tags with vectors are re-associated without a
    //    fresh embedding; tags with neither are skipped (mirror original).
    const fileTagIds: number[] = [];
    for (const tagName of tagNames) {
      let tagId = tagIdByName.get(tagName);
      if (tagId == null) {
        const stored = await metadataStore.getTagByName(tagName);
        if (stored && stored.vector) tagId = stored.id;
      }
      if (tagId != null) fileTagIds.push(tagId);
    }
    await metadataStore.setFileTags(fileId, fileTagIds);

    await this._maybeWriteCheckpoint(fileInfo, { chunkIds, tagIds: fileTagIds }, ctx);

    return {
      ...fileInfo,
      fileId,
      chunkIds,
      tagIds: newTagIds,
      removedChunkIds,
      previousIndexName: existing?.diary_name || existing?.diaryName || null,
      currentIndexName: diaryName,
    };
  }

  async _maybeWriteCheckpoint(
    fileInfo: PipelineData,
    counts: { chunkIds: number[]; tagIds: number[] },
    ctx: PipelineContextLike,
  ): Promise<void> {
    const config = ctx.config || {};
    const cp = config.checkpoint;
    const explicitEnabled =
      cp === true || (typeof cp === "object" && cp.enabled !== false);
    const bareInterval = Number.isFinite(config.checkpointInterval);
    if (!explicitEnabled && !bareInterval) return;

    const interval =
      typeof cp === "object" && cp.interval != null
        ? cp.interval
        : config.checkpointInterval || 1;

    ctx.checkpointState = ctx.checkpointState || { fileCount: 0, diaries: new Set() };
    const state = ctx.checkpointState;
    state.fileCount += 1;
    if (fileInfo.diaryName) state.diaries.add(fileInfo.diaryName);
    if (state.fileCount % interval !== 0) return;

    const kv = ctx.metadataStore;
    if (!kv?.setKv) return;
    await kv.setKv(CHECKPOINT_KEYS.memoryCheckpoint, String(Date.now()));
    await kv.setKv(CHECKPOINT_KEYS.lastFileIndexed, fileInfo.relPath || "");
    await kv.setKv(CHECKPOINT_KEYS.chunkCount, String(counts.chunkIds.length));
    await kv.setKv(CHECKPOINT_KEYS.tagCount, String(counts.tagIds.length));
    await kv.setKv(CHECKPOINT_KEYS.diaryCount, String(state.diaries.size));
  }
}

export default MetadataWriterStage;
