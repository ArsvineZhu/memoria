import type { PipelineContextLike, PipelineData } from '../types';
import Stage = require('./stage');

/**
 * A pipeline composes stages sequentially.
 * Each stage's output feeds into the next stage's input.
 */
class Pipeline {
  readonly stages: Stage<PipelineData, PipelineData>[];
  name?: string;
  /**
   * @param {import('./stage').Stage[]} stages
   */
  constructor(stages: Stage<PipelineData, PipelineData>[] = []) {
    this.stages = stages;
  }

  /**
   * Run all stages in sequence.
   * @param {unknown} initialInput
   * @param {import('./context').PipelineContext} ctx
   * @returns {Promise<unknown>}
   */
  async run(initialInput: PipelineData, ctx: PipelineContextLike): Promise<PipelineData> {
    let data = initialInput;
    for (const stage of this.stages) {
      data = await stage.process(data, ctx);
    }
    return data;
  }

  /**
   * Return a new Pipeline with an additional stage (immutable).
   * @param {import('./stage').Stage} stage
   * @returns {Pipeline}
   */
  pipe(stage: Stage<PipelineData, PipelineData>): Pipeline {
    return new Pipeline([...this.stages, stage]);
  }

  /**
   * Return a new Pipeline with a stage replaced by name.
   * @param {string} stageName
   * @param {import('./stage').Stage} newStage
   * @returns {Pipeline}
   */
  replace(stageName: string, newStage: Stage<PipelineData, PipelineData>): Pipeline {
    return new Pipeline(
      this.stages.map(s => (s.name === stageName ? newStage : s))
    );
  }
}

export = Pipeline;
