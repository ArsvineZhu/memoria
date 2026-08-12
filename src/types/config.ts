import type { RetrievalPlan, RetrievalPlanInput } from "../retrieval/retrieval-plan.js";
import type { MemoryEngine } from "../engine.js";
import type {
  ExternalReranker,
  QueryRephraser,
  SourcePriority,
  Tokenizer,
} from "./common.js";
import type { EmbeddingProviderContract } from "./embedding.js";
import type { MetadataStoreContract } from "./metadata.js";
import type { VectorStoreContract } from "./vector.js";

export type SupportSelectionMethod =
  "mass_ratio" | "tail_budget" | "shannon" | "participation_ratio" | "largest_mass_gap";

/** Public configuration contains retrieval parameters, not per-query stage selection. */
export interface MemoryConfig {
  dataPath: string;
  rootPath: string;
  storePath: string;
  dbPath: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  modelSig: string;
  fallbackModels: string[];
  maxBatchItems: number;
  maxToken: number;
  concurrency: number;
  dimension: number;
  tagVectorIndexCapacity: number;
  indexSaveDelay: number;
  tagVectorIndexSaveDelay: number;
  persistTagVectorIndex: boolean;
  busyTimeout: number;
  busyRetryDelay: number;
  chunkMaxTokens: number;
  chunkOverlapTokens: number;
  maxTokens: number;
  overlapTokens: number;
  tagBlacklist: string[];
  tagBlacklistSuper: string[];
  maxTagsPerFile: number;
  cooccurrenceRebuild: boolean;
  relationGraphEnabled: boolean;
  checkpoint: boolean | { enabled?: boolean; interval?: number };
  checkpointInterval: number;
  truncateMinScore?: number;
  relationMaxHops: number;
  relationMaxAdded: number;
  relationExpansionSeeds: number;
  topK: number;
  perIndexK: number | null;
  indexNames: string[] | null;
  searchAllIndices: boolean;
  tagSearchEnabled: boolean;
  tagVectorIndexName: string;
  tagVectorTopK: number;
  queryExpansion: number;
  queryEpsilon: number | null;
  queryRephraserFn: QueryRephraser | null;
  stopWords: string[];
  tokenizer: Tokenizer | null;
  bm25K1: number;
  bm25B: number;
  bm25PoolK: number;
  minScore: number;
  vectorWeight: number;
  bm25Weight: number;
  dedupeSemantic: boolean;
  semanticThreshold: number;
  dedupeMaxResults: number;
  minSemanticCandidates: number;
  maxResults: number;
  sourcePriority: SourcePriority;
  externalRerankMode: "ordered" | "rrf";
  externalRerankAlpha: number;
  timeDecayHalfLife: number;
  timeDecayNow: number | null;
  timeDecayUpperBound: number | null;
  maxContentLength: number;
  truncateEllipsis: boolean;
  expandCount: number;
  expansionBoost: number;
  associateCount: number;
  associatorSeeds: number;
  associatorTagBoost: number;
  associatorVecK: number;
  associatorVecBoost: number;
  associatorUseVector: boolean;
  tagBasisClusterCount: number;
  tagBasisMaxDimensions: number;
  tagBasisPerCandidateAnalysis: boolean;
  strictOrthogonalization: boolean;
  residualMaxSteps: number;
  residualTagTopK: number;
  residualStopEnergyRatio: number;
  propagationMaxHops: number;
  routingBudget: number;
  activationThreshold: number;
  standardEdgePropagationFactor: number;
  shortcutEdgePropagationFactor: number;
  shortcutEdgeThreshold: number;
  shortcutEdgeGain: number;
  shortcutEdgeReserveMass: number;
  maxNeighborsPerNode: number;
  returnActivationFactor: number;
  hopReadoutGamma: number;
  maxPropagationStates: number;
  minimumInjectedActivation: number;
  localDiffusionAlpha: number;
  extendedDiffusionAlpha: number;
  diffusionMaxIterations: number;
  localDiffusionTolerance: number;
  extendedDiffusionTolerance: number;
  supportSelectionMethod: SupportSelectionMethod;
  localSupportMassRatio: number;
  extendedSupportMassRatio: number;
  historyUpdateScale: number;
  historyRerankCap: number;
  supportRerankAlpha: number;
  supportRerankMinSamples: number;
  tdbEnabled: boolean;
  tdbRootPath: string;
  tdbStorePath: string;
  tdbDbPath: string;
  tdbModel: string;
  tdbDimension: number;
  tdbEmbeddingBatchSize: number;
  tdbExtensions: string[];
  tdbExcludeFolders: string[];
  tdbSyncMode: string;
  tdbForceQuery: string | null;
  tdbHybridAlpha: number;
  tdbTopK: number;
  tdbMinScore: number;
  tdbExpandDepth: number;
  tdbTimeDecayEnabled: boolean;
}

/** Internal plan-compiled configuration used only by the search pipeline. */
export interface ResolvedMemoryConfig extends MemoryConfig {
  tagBasisProjectionEnabled: boolean;
  tagResidualDecompositionEnabled: boolean;
  tagGraphPropagationEnabled: boolean;
  propagationSupportRerankEnabled: boolean;
  propagationStructureRerankEnabled: boolean;
  propagationHistoryEnabled: boolean;
  embeddingRerankEnabled: boolean;
  nativeTagRetrievalEnabled: boolean;
  tagExpansionEnabled: boolean;
  associatorEnabled: boolean;
  externalRerankEnabled: boolean;
  timeDecayEnabled: boolean;
  truncateEnabled: boolean;
  expansionEnabled: boolean;
  fullDocumentExpansionEnabled: boolean;
  relationExpansionEnabled: boolean;
  dedupeEnabled: boolean;
  retrievalPlan?: RetrievalPlan;
  retrievalFilters?: RetrievalPlan["filters"];
}

export type MemoryConfigOverrides = Partial<MemoryConfig>;
export type ResolvedMemoryConfigOverrides = Partial<ResolvedMemoryConfig>;

export interface MemoryEngineOptions {
  config?: MemoryConfigOverrides;
  /** Fixed per-engine retrieval defaults; normalized at construction time. */
  defaultRetrievalPlan?: RetrievalPlanInput;
  dbPath?: string;
  embeddingProvider?: EmbeddingProviderContract;
  vectorStore?: VectorStoreContract;
  metadataStore?: MetadataStoreContract;
  /** Optional model reranker injected into the external rerank stage. */
  reranker?: ExternalReranker;
  searchOptions?: Pick<SearchOptions, "queryExpansion" | "queryEpsilon">;
  onReady?: (engine: MemoryEngine) => void | Promise<void>;
}

export interface SearchOptions {
  retrievalPlan?: RetrievalPlanInput;
  inheritRetrievalDefaults?: boolean;
  topK?: number;
  indexNames?: string[];
  spaces?: string[];
  queryExpansion?: number;
  queryEpsilon?: number | null;
}
