import type { EmbeddingProviderContract } from "../types/embedding.js";
import type { MetadataStoreContract } from "../types/metadata.js";
import type { VectorStoreContract } from "../types/vector.js";
import type { PipelineContextOptions } from "../types/pipeline.js";

/**
 * Dependency injection container shared across all stages in a pipeline.
 */
class PipelineContext {
  readonly config: PipelineContextOptions["config"];
  readonly embeddingProvider?: EmbeddingProviderContract | null;
  readonly vectorStore?: VectorStoreContract | null;
  readonly metadataStore?: MetadataStoreContract | null;
  readonly tagRetrievalRuntime?: unknown;
  tagBasisProjection?: PipelineContextOptions["tagBasisProjection"];
  readonly propagationHistoryStore?: PipelineContextOptions["propagationHistoryStore"];
  readonly tagAssociationGraph?: Map<number, Map<number, number>>;
  reranker?: PipelineContextOptions["reranker"];
  readonly queryInterpreter?: PipelineContextOptions["queryInterpreter"];
  checkpointState?: { fileCount: number; spaces: Set<string> };
  /**
   * @param {object} opts
   * @param {object} opts.config - RAG parameters
   * @param {import('../interfaces/embedding-provider.js')} [opts.embeddingProvider]
   * @param {import('../interfaces/vector-store.js')} [opts.vectorStore]
   * @param {import('../interfaces/metadata-store.js')} [opts.metadataStore]
   * @param {import('../interfaces/metadata-store.js')} [opts.metadataStore]
   * @param {object} [opts.tagRetrievalRuntime] - Internal native tag retrieval handle
   * @param {object} [opts.tagBasisProjection] - Prepared tag basis projection
   * @param {object} [opts.propagationHistoryStore] - Persistent propagation history store
   * @param {Map} [opts.tagAssociationGraph] - tag co-occurrence graph for tag retrieval stages
   */
  constructor({
    config,
    embeddingProvider,
    vectorStore,
    metadataStore,
    tagRetrievalRuntime,
    tagBasisProjection,
    propagationHistoryStore,
    tagAssociationGraph,
    reranker,
    queryInterpreter,
  }: PipelineContextOptions) {
    this.config = config;
    this.embeddingProvider = embeddingProvider;
    this.vectorStore = vectorStore;
    this.metadataStore = metadataStore;
    this.tagRetrievalRuntime = tagRetrievalRuntime;
    this.tagBasisProjection = tagBasisProjection;
    this.propagationHistoryStore = propagationHistoryStore;
    this.tagAssociationGraph = tagAssociationGraph;
    this.reranker = reranker;
    this.queryInterpreter = queryInterpreter;
  }
}

export default PipelineContext;
