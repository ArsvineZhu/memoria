'use strict';

/**
 * @abstract
 * Base class for all pipeline stages.
 * Each stage transforms input -> output via process().
 */
class Stage {
  /**
   * @param {any} input - Output from previous stage
   * @param {import('./context').PipelineContext} ctx - Shared context
   * @returns {Promise<any>} Output for next stage
   */
  async process(input, ctx) {
    throw new Error('Stage.process() must be implemented by subclass');
  }
}

module.exports = Stage;
