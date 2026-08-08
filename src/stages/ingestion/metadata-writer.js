'use strict';

const Stage = require('../../core/stage');
const { encodeVectorBlob } = require('../../utils/vector-codec');

// kv_store checkpoint keys (mirror of the legacy KnowledgeBaseManager
// naming convention; only written when the pipeline opts in via config).
const CHECKPOINT_KEYS = {
  memoryCheckpoint: 'memory_checkpoint',
  lastFileIndexed: 'last_file_indexed',
  chunkCount: 'chunk_count',
  tagCount: 'tag_count',
  diaryCount: 'diary_count'
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
    this.name = 'metadataWriter';
  }

  async process(input, ctx) {
    const fileInfo = input || {};
    const metadataStore = ctx.metadataStore;

    // Caller-supplied skip: the file did not change, nothing to write.
    if (fileInfo.needsEmbedding === false) {
      const existing = await metadataStore.getFileByPath(fileInfo.relPath);
      return {
        ...fileInfo,
        fileId: existing ? existing.id : null,
        chunkIds: [],
        tagIds: [],
        removedChunkIds: [],
        skipped: true
      };
    }

    const chunkEntries = Array.isArray(fileInfo.chunkEntries)
      ? fileInfo.chunkEntries
      : [];
    const tagEntries = Array.isArray(fileInfo.tagEntries)
      ? fileInfo.tagEntries
      : [];
    const tagNames = Array.isArray(fileInfo.tags) ? fileInfo.tags : [];

    // 1. Collect existing chunk ids BEFORE replacement so the vector index
    //    can remove stale vectors (ids are gone after insertChunks runs).
    let removedChunkIds = [];
    const existing = await metadataStore.getFileByPath(fileInfo.relPath);
    if (existing) {
      const oldChunks = await metadataStore.getChunksByFileId(existing.id);
      removedChunkIds = oldChunks.map(c => c.id);
    }

    // 2. Upsert the file row (provider refreshes updated_at).
    const fileId = await metadataStore.upsertFile({
      path: fileInfo.relPath,
      diaryName: fileInfo.diaryName,
      checksum: fileInfo.checksum,
      mtime: fileInfo.mtime,
      size: fileInfo.size
    });

    // 3. Insert chunk rows; vectors are serialized to BLOB buffers.
    const chunkRows = chunkEntries.map(entry => ({
      chunkIndex: entry.chunkIndex,
      content: entry.content,
      vector: entry.vector == null ? null : encodeVectorBlob(entry.vector)
    }));
    const chunkIds = await metadataStore.insertChunks(fileId, chunkRows);

    // 4. Upsert tag rows; ids are aligned with tagEntries.
    const tagRows = tagEntries.map(entry => ({
      name: entry.name,
      vector: entry.vector == null ? null : encodeVectorBlob(entry.vector)
    }));
    const newTagIds = await metadataStore.upsertTags(tagRows);
    const tagIdByName = new Map();
    tagEntries.forEach((entry, i) => {
      if (newTagIds[i] != null) tagIdByName.set(entry.name, newTagIds[i]);
    });

    // 5. Rebuild the file_tags association preserving input tag order.
    //    Previously stored tags with vectors are re-associated without a
    //    fresh embedding; tags with neither are skipped (mirror original).
    const fileTagIds = [];
    for (const tagName of tagNames) {
      let tagId = tagIdByName.get(tagName);
      if (tagId == null) {
        const stored = await metadataStore.getTagByName(tagName);
        if (stored && stored.vector) tagId = stored.id;
      }
      if (tagId != null) fileTagIds.push(tagId);
    }
    await metadataStore.setFileTags(fileId, fileTagIds);

    await this._maybeWriteCheckpoint(
      fileInfo,
      { chunkIds, tagIds: fileTagIds },
      ctx
    );

    return {
      ...fileInfo,
      fileId,
      chunkIds,
      tagIds: newTagIds,
      removedChunkIds
    };
  }

  async _maybeWriteCheckpoint(fileInfo, counts, ctx) {
    const config = ctx.config || {};
    const cp = config.checkpoint;
    const explicitEnabled = cp === true || (cp && cp.enabled !== false);
    const bareInterval = Number.isFinite(config.checkpointInterval);
    if (!explicitEnabled && !bareInterval) return;

    const interval = cp && cp.interval != null
      ? cp.interval
      : (config.checkpointInterval || 1);

    ctx.checkpointState = ctx.checkpointState || { fileCount: 0, diaries: new Set() };
    const state = ctx.checkpointState;
    state.fileCount += 1;
    if (fileInfo.diaryName) state.diaries.add(fileInfo.diaryName);
    if (state.fileCount % interval !== 0) return;

    const kv = ctx.metadataStore;
    await kv.setKv(CHECKPOINT_KEYS.memoryCheckpoint, String(Date.now()));
    await kv.setKv(CHECKPOINT_KEYS.lastFileIndexed, fileInfo.relPath);
    await kv.setKv(CHECKPOINT_KEYS.chunkCount, String(counts.chunkIds.length));
    await kv.setKv(CHECKPOINT_KEYS.tagCount, String(counts.tagIds.length));
    await kv.setKv(CHECKPOINT_KEYS.diaryCount, String(state.diaries.size));
  }
}

module.exports = MetadataWriterStage;