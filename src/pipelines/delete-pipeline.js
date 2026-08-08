'use strict';

const Pipeline = require('../core/pipeline');
const FileDeleterStage = require('../stages/ingestion/file-deleter');

/**
 * DeletePipeline — single-file removal pipeline.
 *
 * Mirrors KnowledgeBaseManager._handleDeleteBatch for one file: the file
 * row plus its chunk rows (FK cascade) are removed and the chunk vectors
 * are dropped from the diary index. Tag rows and the shared tag index are
 * intentionally left untouched (tags are shared across files).
 *
 * Usage:
 *   const pipeline = new DeletePipeline();
 *   const result = await pipeline.deleteFile('diary1/note.md', ctx);
 *   // ctx: { metadataStore, vectorStore, config: { rootPath? } }
 *
 * Result envelope: {0...source info, deleted: boolean, fileId, removedChunkIds}.
 * Idempotent: unknown paths resolve to { deleted: false }.
 */
class DeletePipeline extends Pipeline {
  /**
   * @param {object} [config={}] - pipeline-level config (forwarded to ctx.config)
   * @param {object} [options={}]
   * @param {import('../core/stage').Stage[]} [options.stages] - explicit chain override
   */
  constructor(config = {}, options = {}) {
    const stages = Array.isArray(options.stages)
      ? options.stages
      : DeletePipeline.defaultStages(config);
    super(stages);
    this.name = 'deletePipeline';
    this.config = config || {};
  }

  /**
   * Default deletion chain: a single FileDeleterStage.
   * @param {object} config - unused today; kept for future gates
   * @returns {import('../core/stage').Stage[]}
   */
  static defaultStages(config) {
    return [new FileDeleterStage()];
  }

  /**
   * Convenience: delete one file by path.
   * @param {string} filePath - stored relative path (or absolute with rootPath)
   * @param {import('../core/context').PipelineContext} ctx
   * @returns {Promise<object>} stage result envelope
   */
  deleteFile(filePath, ctx) {
    return this.run({ path: filePath }, ctx);
  }
}

module.exports = DeletePipeline;