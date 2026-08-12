import type { PipelineContextLike, PipelineData } from "../types/pipeline.js";
import Stage from "./stage.js";

/**
 * A pipeline composes stages sequentially.
 * Each stage's output feeds into the next stage's input.
 */
class Pipeline<
  Input extends PipelineData = PipelineData,
  Output extends PipelineData = PipelineData,
> {
  readonly stages: Stage[];
  name?: string;
  /**
   * @param {import('./stage.js').Stage[]} stages
   */
  constructor(stages: Stage[] = []) {
    this.stages = stages;
  }

  /**
   * Run all stages in sequence.
   * @param {unknown} initialInput
   * @param {import('./context.js').PipelineContext} ctx
   * @returns {Promise<unknown>}
   */
  async run(initialInput: Input, ctx: PipelineContextLike): Promise<Output> {
    let data: PipelineData = initialInput;
    for (const stage of this.stages) {
      data = await stage.process(data, ctx);
    }
    return data as unknown as Output;
  }

  /**
   * Return a new Pipeline with an additional stage (immutable).
   * @param {import('./stage.js').Stage} stage
   * @returns {Pipeline}
   */
  pipe(stage: Stage): Pipeline<Input, Output> {
    return new Pipeline<Input, Output>([...this.stages, stage]);
  }

  /**
   * Return a new Pipeline with a stage replaced by name.
   * @param {string} stageName
   * @param {import('./stage.js').Stage} newStage
   * @returns {Pipeline}
   */
  replace(stageName: string, newStage: Stage): Pipeline<Input, Output> {
    return new Pipeline<Input, Output>(
      this.stages.map((s) => (s.name === stageName ? newStage : s)),
    );
  }
}

export default Pipeline;
