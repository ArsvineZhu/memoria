'use strict';

/**
 * A pipeline composes stages sequentially.
 * Each stage's output feeds into the next stage's input.
 */
class Pipeline {
  /**
   * @param {import('./stage').Stage[]} stages
   */
  constructor(stages = []) {
    this.stages = stages;
  }

  /**
   * Run all stages in sequence.
   * @param {any} initialInput
   * @param {import('./context').PipelineContext} ctx
   * @returns {Promise<any>}
   */
  async run(initialInput, ctx) {
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
  pipe(stage) {
    return new Pipeline([...this.stages, stage]);
  }

  /**
   * Return a new Pipeline with a stage replaced by name.
   * @param {string} stageName
   * @param {import('./stage').Stage} newStage
   * @returns {Pipeline}
   */
  replace(stageName, newStage) {
    return new Pipeline(
      this.stages.map(s => (s.name === stageName ? newStage : s))
    );
  }
}

module.exports = Pipeline;
