import type {
  EmbeddingProviderContract,
  MemoryConfig,
  MetadataStoreContract,
  PipelineContextOptions,
  VectorStoreContract,
} from "../types.js";

/**
 * Dependency injection container shared across all stages in a pipeline.
 */
class PipelineContext {
  readonly config: PipelineContextOptions["config"];
  readonly embeddingProvider?: EmbeddingProviderContract | null;
  readonly vectorStore?: VectorStoreContract | null;
  readonly metadataStore?: MetadataStoreContract | null;
  /** @deprecated Compatibility escape hatch; native backend types stay internal. */
  readonly vexusIndex?: unknown;
  epa?: PipelineContextOptions["epa"];
  readonly riverStateStore?: PipelineContextOptions["riverStateStore"];
  readonly tagGraph?: Map<number, Map<number, number>>;
  reranker?: PipelineContextOptions["reranker"];
  readonly queryInterpreter?: PipelineContextOptions["queryInterpreter"];
  checkpointState?: { fileCount: number; diaries: Set<string> };
  /**
   * @param {object} opts
   * @param {object} opts.config - RAG parameters
   * @param {import('../interfaces/embedding-provider.js')} [opts.embeddingProvider]
   * @param {import('../interfaces/vector-store.js')} [opts.vectorStore]
   * @param {import('../interfaces/metadata-store.js')} [opts.metadataStore]
   * @param {import('../interfaces/metadata-store.js')} [opts.metadataStore]
   * @param {object} [opts.vexusIndex] - Raw Rust N-API handle for algorithm layer
   * @param {import('../algorithms/epa.js').EPA} [opts.epa] - Pre-built EPA basis for the memo pipeline
   * @param {object} [opts.riverStateStore] - KV store for persistent RiverMemo state
   * @param {Map} [opts.tagGraph] - tag co-occurrence graph for TagMemo stages
   */
  constructor({
    config,
    embeddingProvider,
    vectorStore,
    metadataStore,
    vexusIndex,
    epa,
    riverStateStore,
    tagGraph,
    reranker,
    queryInterpreter,
  }: PipelineContextOptions) {
    this.config = config;
    this.embeddingProvider = embeddingProvider;
    this.vectorStore = vectorStore;
    this.metadataStore = metadataStore;
    this.vexusIndex = vexusIndex;
    this.epa = epa;
    this.riverStateStore = riverStateStore;
    this.tagGraph = tagGraph;
    this.reranker = reranker;
    this.queryInterpreter = queryInterpreter;
  }
}

export default PipelineContext;
