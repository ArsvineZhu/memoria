'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const Stage = require('../../core/stage');

/**
 * Reads a file from disk (or accepts caller-supplied content),
 * computes its md5 checksum, and decides whether re-embedding is needed.
 *
 * Decision rule (ported from ingestionPipeline._flushBatch):
 * a file does NOT need re-embedding when a stored metadata row exists for
 * its relative path and checksum/size/mtime all match the current snapshot.
 *
 * @param {{ path: string, content?: string, mtime?: number, size?: number }} input
 *   - path: absolute file path
 *   - content/mtime/size: optional pre-read snapshot (fallbackRead mode);
 *     when provided the stage skips filesystem reads entirely.
 */
class FileReaderStage extends Stage {
  constructor() {
    super();
    this.name = 'fileReader';
  }

  async process(input, ctx) {
    if (!input || typeof input.path !== 'string') {
      throw new TypeError('FileReaderStage requires input.path');
    }

    const filePath = input.path;
    const rootPath = ctx.config && ctx.config.rootPath;

    let content = input.content;
    let mtime = input.mtime;
    let size = input.size;
    let unstable = false;

    if (typeof content !== 'string' || typeof mtime !== 'number' || typeof size !== 'number') {
      const statsBefore = await fs.promises.stat(filePath);
      mtime = Math.trunc(statsBefore.mtimeMs);
      size = statsBefore.size;
      content = await fs.promises.readFile(filePath, 'utf-8');

      // Truth-snapshot guard: if the file changed while being read, the
      // snapshot is unstable and must not be written as a final state.
      let statsAfter;
      try {
        statsAfter = await fs.promises.stat(filePath);
      } catch (e) {
        statsAfter = null;
      }
      if (
        statsAfter &&
        (statsAfter.size !== statsBefore.size || Math.trunc(statsAfter.mtimeMs) !== mtime)
      ) {
        unstable = true;
      }
    }

    const relPathRaw = input.relPath ||
      (rootPath
        ? path.relative(rootPath, filePath)
        : path.basename(filePath));
    // Relative paths are stored with forward slashes on every platform
    // (mirrors the original knowledge base path convention).
    const relPath = relPathRaw.split(path.sep).join('/');
    const parts = relPath.split('/');
    const diaryName = parts.length > 1 ? parts[0] : 'Root';

    const checksum = crypto.createHash('md5').update(content).digest('hex');

    let needsEmbedding = true;
    if (!unstable && ctx.metadataStore) {
      const row = await ctx.metadataStore.getFileByPath(relPath);
      if (row && row.checksum === checksum && row.size === size && row.mtime === mtime) {
        needsEmbedding = false;
      }
    }

    return {
      path: filePath,
      relPath,
      diaryName,
      content,
      checksum,
      mtime,
      size,
      needsEmbedding,
      unstable
    };
  }
}

module.exports = FileReaderStage;