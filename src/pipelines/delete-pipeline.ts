"use strict";

import Pipeline from "../core/pipeline.js";
import FileDeleterStage from "../stages/ingestion/file-deleter.js";
import Stage from "../core/stage.js";
import type {
  DeleteEnvelope,
  MemoryConfigOverrides,
  PipelineContextLike,
} from "../types.js";

interface PipelineOptions {
  stages?: Stage[];
}

/**
 * DeletePipeline — single-file removal pipeline.
 *
 * Handles one file deletion in the MemoryEngine pipeline: the file
 * row plus its chunk rows (FK cascade) are removed and the chunk vectors
 * are dropped from the space index. Tag rows and the shared tag index are
 * intentionally left untouched (tags are shared across files).
 *
 * Usage:
 *   const pipeline = new DeletePipeline();
 *   const result = await pipeline.deleteFile('space1/note.md', ctx);
 *   // ctx: { metadataStore, vectorStore, config: { rootPath? } }
 *
 * Result envelope: {0...source info, deleted: boolean, fileId, removedChunkIds}.
 * Idempotent: unknown paths resolve to { deleted: false }.
 */
class DeletePipeline extends Pipeline {
  config: MemoryConfigOverrides;
  /**
   * @param {object} [config={}] - pipeline-level config (forwarded to ctx.config)
   * @param {object} [options={}]
   * @param {import('../core/stage.js').Stage[]} [options.stages] - explicit chain override
   */
  constructor(config: MemoryConfigOverrides = {}, options: PipelineOptions = {}) {
    const stages = Array.isArray(options.stages)
      ? options.stages
      : DeletePipeline.defaultStages(config);
    super(stages);
    this.name = "deletePipeline";
    this.config = config || {};
  }

  /**
   * Default deletion chain: a single FileDeleterStage.
   * @param {object} config - unused today; kept for future gates
   * @returns {import('../core/stage.js').Stage[]}
   */
  static defaultStages(_config: MemoryConfigOverrides): Stage[] {
    return [new FileDeleterStage()];
  }

  /**
   * Convenience: delete one file by path.
   * @param {string} filePath - stored relative path (or absolute with rootPath)
   * @param {import('../core/context.js').PipelineContext} ctx
   * @returns {Promise<object>} stage result envelope
   */
  deleteFile(filePath: string, ctx: PipelineContextLike): Promise<DeleteEnvelope> {
    return this.run({ path: filePath }, ctx) as Promise<DeleteEnvelope>;
  }
}

export default DeletePipeline;
