import type { PipelineContextLike, PipelineData } from "../../types.js";

import Stage from "../../core/stage.js";

/**
 * Tag co-occurrence bridge stage.
 *
 * The original KnowledgeBaseManager does NOT write co-occurrence counts
 * during ingestion: the matrix is derived from the file_tags table on
 * demand (SQL self-join in buildCooccurrenceMatrix / Rust TagMemo engine).
 *
 * Accordingly this stage is a no-op by default. When the pipeline opts in
 * via config.cooccurrenceRebuild (e.g. a periodic cache refresh), it
 * triggers a full matrix rebuild and attaches the resulting Map to the
 * output.
 *
 * Config (ctx.config):
 *   - cooccurrenceRebuild: boolean, default false
 */
class CooccurrenceBuilderStage extends Stage {
  constructor() {
    super();
    this.name = "cooccurrenceBuilder";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "cooccurrenceMatrix"> & {
      cooccurrenceMatrix?: Map<number, Map<number, number>>;
      cooccurrenceSkipped?: boolean;
    }
  > {
    const info = input || {};
    const config = ctx.config || {};

    if (config.cooccurrenceRebuild === true && ctx.metadataStore) {
      const matrix = await ctx.metadataStore.buildCooccurrenceMatrix();
      return { ...info, cooccurrenceMatrix: matrix };
    }

    return { ...info, cooccurrenceSkipped: true };
  }
}

export default CooccurrenceBuilderStage;
