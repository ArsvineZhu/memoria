'use strict';

/**
 * Dependency injection container shared across all stages in a pipeline.
 */
class PipelineContext {
  /**
   * @param {object} opts
   * @param {object} opts.config - RAG parameters
   * @param {import('../interfaces/embedding-provider')} [opts.embeddingProvider]
   * @param {import('../interfaces/vector-store')} [opts.vectorStore]
   * @param {import('../interfaces/metadata-store')} [opts.metadataStore]
* @param {import('../interfaces/metadata-store')} [opts.metadataStore]
* @param {object} [opts.vexusIndex] - Raw Rust N-API handle for algorithm layer
    * @param {import('../algorithms/epa').EPA} [opts.epa] - Pre-built EPA basis for the memo pipeline
* @param {object} [opts.riverStateStore] - KV store for persistent RiverMemo state
* @param {Map} [opts.tagGraph] - tag co-occurrence graph for TagMemo stages
    */
  constructor({ config, embeddingProvider, vectorStore, metadataStore, vexusIndex, epa, riverStateStore, tagGraph }) {
    this.config = config;
    this.embeddingProvider = embeddingProvider;
    this.vectorStore = vectorStore;
    this.metadataStore = metadataStore;
    this.vexusIndex = vexusIndex;
    this.epa = epa;
    this.riverStateStore = riverStateStore;
    this.tagGraph = tagGraph;
  }
}

module.exports = PipelineContext;
