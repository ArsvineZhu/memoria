'use strict';

const path = require('path');

const Stage = require('../../core/stage');

/**
 * Removes a single file from the knowledge base: file row, chunk rows and
 * the corresponding vectors in the diary index.
 *
 * Mirrors KnowledgeBaseManager._handleDeleteBatch:
 *  - file_tags and chunks are removed with the file row (FK cascade here;
 *    the original deletes them explicitly as a safety net)
 *  - chunk vectors are removed from the index named after the diary
 *  - removal is idempotent: unknown paths return { deleted: false } and
 *    removing an already-absent vector never throws
 *  - scheduleIndexSave is triggered on the affected diary index
 *
 * Note: tag rows and the global tag index are intentionally left untouched
 * (tags are shared across files in the original design).
 *
 * Config (ctx.config):
 *   - rootPath: used to convert an absolute input.path into the stored
 *     relative path (mirrors FileReaderStage resolution).
 */
class FileDeleterStage extends Stage {
  constructor() {
    super();
    this.name = 'fileDeleter';
  }

  async process(input, ctx) {
    const info = input || {};
    const metadataStore = ctx.metadataStore;
    const rootPath = ctx.config && ctx.config.rootPath;

    let relPath = info.relPath;
    if (typeof relPath !== 'string' && typeof info.path === 'string') {
      relPath = (rootPath && path.isAbsolute(info.path))
        ? path.relative(rootPath, info.path)
        : info.path;
    }
    // Relative paths are stored with forward slashes on every platform.
    if (typeof relPath === 'string') {
      relPath = relPath.split(path.sep).join('/');
    }
    if (typeof relPath !== 'string' || relPath.length === 0) {
      return { ...info, deleted: false };
    }

    const row = await metadataStore.getFileByPath(relPath);
    if (!row) return { ...info, deleted: false };

    const diaryName = info.diaryName || row.diary_name;
    const oldChunks = await metadataStore.getChunksByFileId(row.id);
    const removedChunkIds = oldChunks.map(c => c.id);

    await metadataStore.deleteFile(row.id);

    if (ctx.vectorStore && removedChunkIds.length > 0) {
      const indexName = diaryName;
      for (const id of removedChunkIds) {
        await this._safeRemove(ctx.vectorStore, indexName, id);
      }
      if (typeof ctx.vectorStore.scheduleIndexSave === 'function') {
        ctx.vectorStore.scheduleIndexSave(indexName);
      }
    }

    return { ...info, deleted: true, fileId: row.id, removedChunkIds };
  }

  async _safeRemove(vectorStore, indexName, id) {
    try {
      await vectorStore.remove(indexName, id);
    } catch (e) {
      // Delete events may arrive out of order or duplicated; a missing
      // vector must not break the delete batch (mirror original).
      if (e && e.message && /not found|missing|absent/i.test(e.message)) {
        return;
      }
      throw e;
    }
  }
}

module.exports = FileDeleterStage;