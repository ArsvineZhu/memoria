import type {
  PipelineContextLike,
  PipelineData,
  Stage as StageContract,
} from "../types.js";

/**
 * @abstract
 * Base class for all pipeline stages.
 * Each stage transforms input -> output via process().
 */
class Stage<Input = PipelineData, Output = PipelineData> implements StageContract<
  Input,
  Output
> {
  name?: string;
  /**
   * @param {unknown} input - Output from previous stage
   * @param {import('./context.js').PipelineContext} ctx - Shared context
   * @returns {Promise<unknown>} Output for next stage
   */
  async process(_input: Input, _ctx: PipelineContextLike): Promise<Output> {
    throw new Error("Stage.process() must be implemented by subclass");
  }
}

export default Stage;
