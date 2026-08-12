import type { RetrievalPlan, RetrievalPlanInput } from "./retrieval/retrieval-plan.js";
import type { RetrievalStrategySource } from "./retrieval/query-planner.js";

/** A vector accepted at the public boundary before it is normalised. */
export type VectorLike = Float32Array | readonly number[];
export type Vector = Float32Array;
export type EmbeddingVector = VectorLike;

export type UnknownRecord = Record<string, unknown>;

export interface SourcePriority {
  semantic?: number;
  time?: number;
  bm25Body?: number;
  bm25Tag?: number;
  continuity?: number;
  associate?: number;
  unknown?: number;
}

export type QueryRephraser = (query: string, index: number) => string | Promise<string>;
export type ExternalReranker = (
  query: string,
  results: readonly ChunkCandidate[],
) => readonly ChunkCandidate[] | Promise<readonly ChunkCandidate[]>;
export type Tokenizer = (
  text: string,
) => readonly string[] | Promise<readonly string[]>;

/** Fully materialised runtime configuration. */
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
  truncateMinScore?: number;
  expansionEnabled: boolean;
  fullDocumentExpansionEnabled: boolean;
  relationExpansionEnabled: boolean;
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
  dedupeEnabled: boolean;
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
  supportSelectionMethod: string;
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
  retrievalPlan?: RetrievalPlan;
  retrievalFilters?: RetrievalPlan["filters"];
}

export type MemoryConfigOverrides = Partial<MemoryConfig>;

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
  searchOptions?: SearchOptions;
  onReady?: (engine: MemoryEngineOptions) => void | Promise<void>;
}

export interface SearchOptions {
  retrievalPlan?: RetrievalPlanInput;
  inheritRetrievalDefaults?: boolean;
  topK?: number;
  indexNames?: string[];
  spaces?: string[];
  retrievalFilters?: RetrievalPlan["filters"];
  queryExpansion?: number;
  queryEpsilon?: number | null;
  externalRerank?: boolean;
}

export type MemoryDocumentFormat = "text" | "markdown" | "mdx";

/** Host-neutral provenance attached to a logical memory document. */
export interface MemoryDocumentSource extends UnknownRecord {
  type?: string;
  id?: string;
}

/** Content-centered ingestion input. It deliberately has no filesystem path. */
export interface MemoryDocumentInput {
  id: string;
  content: string;
  format?: MemoryDocumentFormat;
  /** Optional immutable source snapshot when content is a parsed projection. */
  sourceContent?: string;
  source?: MemoryDocumentSource;
  revision?: string | number;
  metadata?: UnknownRecord;
  updatedAt?: number;
}

export interface MemoryDocumentIngestResult extends IngestEnvelope {
  documentId: string;
  revision?: string;
  source?: MemoryDocumentSource;
  metadata?: UnknownRecord;
}

export interface MemoryDocumentDeleteResult extends DeleteEnvelope {
  documentId: string;
}

export interface FileInput {
  path: string;
  relPath?: string;
  content?: string;
  format?: MemoryDocumentFormat;
  /** Optional raw source snapshot; content may be a parsed/body projection. */
  sourceContent?: string;
  mtime?: number;
  size?: number;
  documentId?: string;
  revision?: string;
  documentSource?: MemoryDocumentSource;
  documentMetadata?: UnknownRecord;
  space?: string;
}

export interface FileSnapshot extends Omit<
  Required<FileInput>,
  | "documentId"
  | "revision"
  | "documentSource"
  | "documentMetadata"
  | "space"
  | "sourceContent"
  | "format"
> {
  relPath: string;
  content: string;
  format?: MemoryDocumentFormat;
  sourceContent?: string;
  mtime: number;
  size: number;
  space: string;
  checksum: string;
  needsEmbedding: boolean;
  needsChunkEmbedding?: boolean;
  needsTagUpdate?: boolean;
  needsMetadataWrite?: boolean;
  unstable: boolean;
}

export interface ChunkEntry {
  chunkIndex: number;
  content: string;
  vector: EmbeddingVector;
}

export interface TagEntry {
  name: string;
  vector?: EmbeddingVector | null;
}

export interface QueryVector {
  text: string;
  vector: EmbeddingVector | null;
}

export interface VectorHit {
  id: number;
  score: number;
}

export interface VectorResult {
  id?: number | null;
  score: number;
  indexName?: string;
  chunkId?: number | null;
  source?: string | null;
}

export type IndexedVectorResult = Omit<VectorResult, "chunkId" | "indexName"> & {
  indexName: string;
  chunkId: number;
  score: number;
};

export interface SearchResult extends VectorResult {
  content?: string;
  text?: string;
  path?: string;
  sourceFile?: string;
  relPath?: string;
  space?: string;
  similarity?: number;
  updatedAt?: number | null;
  mtime?: number | null;
  fileId?: number | null;
  chunkIndex?: number | null;
  payload?: UnknownRecord;
  tags?: string[];
  matchedTags?: string[];
  checksum?: string;
  documentId?: string;
  revision?: string;
  sourceMetadata?: MemoryDocumentSource;
  metadata?: UnknownRecord;
  associationChannel?: "tag" | "vector";
  associationOf?: number;
  tagMatchScore?: number;
  decay?: number;
  rerankScore?: number;
}

export interface ChunkCandidate {
  chunkId: number;
  score: number;
  tags?: string[];
  content?: string;
  text?: string;
  vector?: VectorLike;
  source?: string;
  vectorScore?: number;
  bm25Score?: number;
  decay?: number;
  embeddingSimilarity?: number;
  supportScore?: number;
  supportBonus?: number;
  structureScore?: number;
  structureBonus?: number;
  structureReliability?: number;
  propagationScore?: number;
  propagationBonus?: number;
  propagationReliability?: number;
  domainHits?: number[];
  [key: string]: unknown;
}

export interface SearchEnvelope {
  query?: string;
  tokens?: string[];
  options?: SearchOptions | TdbSearchOptions;
  queries?: QueryVector[];
  queryVector?: EmbeddingVector;
  vectorResults?: VectorResult[];
  bm25Results?: ChunkCandidate[];
  candidates?: SearchResult[];
  results: SearchResult[];
  resultCount: number;
  tagBasisProjection?: TagBasisProjectionData;
  tagResidualDecomposition?: TagResidualDecompositionData;
  tagGraphPropagation?: TagGraphPropagationData;
  propagationSupport?: PropagationSupportData;
  propagationStructure?: PropagationStructureData;
  propagationHistory?: PropagationHistoryData;
  associatorStats?: AssociatorStats;
  associatorSkipped?: boolean;
  tagExpansion?: TagExpansionData;
  embeddingRerank?: EmbeddingRerankData;
  tagBasisProjectionSkipped?: boolean;
  tagResidualDecompositionSkipped?: boolean;
  tagGraphPropagationSkipped?: boolean;
  graphDiffusionSkipped?: boolean;
  propagationStructureSkipped?: boolean;
  tagExpansionSkipped?: boolean;
  embeddingRerankSkipped?: boolean;
  propagationSupportSkipped?: boolean;
  tagRetrievalSkipped?: boolean;
  tagRetrievalSkipReason?: string;
  dedupeStats?: DedupeStats;
  truncationStats?: TruncationStats;
  expansionStats?: ExpansionStats;
  reranked?: boolean;
  rerankSkipped?: boolean;
  rerankFailure?: "provider_error";
  rerankError?: string;
  tagRetrievalFailure?:
    "artifact_build_failed" | "backend_unavailable" | "invalid_result";
  propagationSupportFailure?:
    "backend_unavailable" | "artifact_unavailable" | "invalid_result";
  propagationStructureFailure?:
    "native_backend_failed" | "artifact_unavailable" | "invalid_result";
  defaultRetrievalPlan?: RetrievalPlan;
  requestedRetrievalPlan?: RetrievalPlanInput;
  retrievalDecision?: {
    strategy: string;
    scores?: Record<string, number>;
    reasons?: string[];
    fallback?: string;
    reason?: string;
    confidence?: number;
    explicit?: boolean;
    strategySource?: RetrievalStrategySource;
    defaultsInherited?: boolean;
    queryOverrideApplied?: boolean;
  };
  retrievalTrace?: {
    defaultPlan?: RetrievalPlan;
    requestedPlan?: RetrievalPlanInput;
    plan: RetrievalPlan;
    strategySource?: RetrievalStrategySource;
    defaultsInherited?: boolean;
    queryOverrideApplied?: boolean;
    profile: UnknownRecord;
    decision: UnknownRecord;
    stageOrder: string[];
    fallbacks: string[];
  };
  failed?: boolean;
}

export interface TagExpansionData {
  added: number[];
  boosted: number[];
}

export interface TagBasisDominantAxis {
  index: number;
  label?: string;
  energy: number;
  projection: number;
}

export interface TagBasisQueryAnalysis {
  projectionConcentration: number;
  entropy: number;
  dominantAxes: TagBasisDominantAxis[];
  axisCoactivation: {
    axisCoactivation: number;
    coactiveAxisPairs: UnknownRecord[];
    [key: string]: unknown;
  };
}

export interface TagBasisProjectionEnvelope {
  ready: boolean;
  queryAnalysis: TagBasisQueryAnalysis;
  candidateAnalyses: UnknownRecord[];
}

export interface TagBasisProjectionData extends TagBasisProjectionEnvelope {}

export interface TagResidualDecompositionFeatures {
  depth: number;
  coverage: number;
  novelty: number;
  coherence: number;
  propagationReadiness: number;
  expansionSignal?: number;
}

export interface TagResidualDecompositionTag {
  id: number;
  name?: string | null;
  contribution?: number;
  isCore?: boolean;
}

export interface TagResidualDecompositionLevel {
  level?: number;
  tags: TagResidualDecompositionTag[];
  projectionMagnitude?: number;
  residualMagnitude?: number;
  residualEnergyRatio?: number;
  energyExplained?: number;
  residualDirectionFeatures?: {
    directionCoherence?: number;
    meanPairwiseDirectionSimilarity?: number;
    noveltySignal?: number;
    directionDispersionHeuristic?: number;
  } | null;
}

export interface TagResidualDecompositionData {
  levels: TagResidualDecompositionLevel[];
  totalExplainedEnergy?: number;
  finalResidual?: Vector | null;
  features?: TagResidualDecompositionFeatures;
}

export interface PropagationTrace extends UnknownRecord {
  nodes?: UnknownRecord[];
  edges?: UnknownRecord[];
  diagnostics?: UnknownRecord;
  [key: string]: unknown;
}

export interface TagGraphPropagationData extends UnknownRecord {
  schema?: string;
  algorithmVersion?: string;
  activations?: Map<number, number>;
  ranked?: UnknownRecord[];
  rankedActivations?: readonly unknown[];
  seedDistribution?: ReadonlyArray<readonly [number, number]>;
  localDistribution?: ReadonlyArray<readonly [number, number]>;
  extendedDistribution?: ReadonlyArray<readonly [number, number]>;
  propagationTrace?: PropagationTrace;
  pruneThreshold?: number;
  prunedDistributionEntries?: number;
  pruneSkipped?: boolean;
  solverDiagnostics?: UnknownRecord & {
    iterations?: number;
    prunedNodeCount?: number;
    converged?: boolean;
  };
  diffusionDiagnostics?: UnknownRecord;
  iterations?: number;
  localSupport?: { ids: readonly number[]; [key: string]: unknown };
  extendedSupport?: { ids: readonly number[]; [key: string]: unknown };
  rankedTags?: unknown[];
}

export interface PropagationHistoryStore {
  getKv(key: string): Promise<string | UnknownRecord | null>;
  setKv(key: string, value: string): Promise<void>;
}

export interface PropagationHistoryData {
  sequence: number;
  edgeTotals: ReadonlyMap<string, number> | ReadonlyArray<readonly [string, number]>;
  spreadClass: string;
  spreadScore: number;
  historySupport: number;
  nodeTotals?: Record<string, number>;
  activeEdges?: number;
  tickFlowMass?: number;
  schema?: string;
}

export interface PropagationSupportData extends UnknownRecord {
  schema?: string;
  alpha?: number;
  minSupportSamples?: number;
  appliedCount?: number;
  degradedCount?: number;
  native?: boolean;
  algorithmVersion?: string;
  diagnostics?: UnknownRecord;
  supportScore?: number;
  supportBonus?: number;
  scores?: Array<{
    chunkId: number;
    originalScore: number;
    supportScore: number;
    normalizedSupportScore: number;
    finalScore: number;
    hitCount: number;
  }>;
}

export interface PropagationStructureData extends UnknownRecord {
  spreadClass?: string;
  spreadScore?: number;
  historySupport?: number;
  structureScore?: number;
  structureBonus?: number;
  structureReliability?: number;
  nodeCount?: number;
  edgeCount?: number;
  nodeTotals?: Record<string, number>;
  rerankedCount?: number;
  activeEdges?: number;
  [key: string]: unknown;
}

export interface PropagationSpreadResult extends UnknownRecord {
  spreadScore: number;
  spreadClass: string;
  activeEdges: number;
  reachedNodes: number;
}

export interface EmbeddingRerankData {
  enabled?: boolean;
  traced?: { checked: number; matched: number; skipped: number };
  appliedCount?: number;
  degradedCount?: number;
}

export interface AssociatorStats {
  added: number;
  fromTags: number;
  fromVector: number;
  skipped: number;
}

export interface DedupeStats {
  removed: number;
  kept: number;
  duplicates: Array<{ chunkId: number }>;
}

export interface TruncationStats {
  dropped: number;
  truncated: number;
  /** Candidates removed by the optional post-rerank score floor. */
  scoreFiltered?: number;
}

export interface ExpansionStats {
  added: number;
  documentsExpanded?: number;
  mode?: "chunks" | "full-document";
}

export interface IngestEnvelope extends FileSnapshot {
  tags?: string[];
  chunks?: string[];
  chunkEntries?: ChunkEntry[];
  tagEntries?: TagEntry[];
  fileId?: number | null;
  chunkIds?: number[];
  tagIds?: number[];
  removedChunkIds?: number[];
  skipped?: boolean;
  documentId?: string;
  revision?: string;
  documentSource?: MemoryDocumentSource;
  documentMetadata?: UnknownRecord;
  [key: string]: unknown;
}

export interface DeleteEnvelope {
  path: string;
  relPath?: string;
  documentId?: string;
  deleted: boolean;
  fileId?: number | null;
  removedChunkIds: number[];
  orphanedTagIds?: number[];
  [key: string]: unknown;
}

/** The common object flowing between ordinary pipeline stages. */
export interface PipelineData extends UnknownRecord {
  path?: string;
  relPath?: string;
  content?: string;
  format?: MemoryDocumentFormat;
  /** Immutable source snapshot used by derived-link extraction; never embedded. */
  sourceContent?: string;
  mtime?: number;
  size?: number;
  space?: string;
  checksum?: string;
  needsEmbedding?: boolean;
  needsChunkEmbedding?: boolean;
  needsTagUpdate?: boolean;
  needsMetadataWrite?: boolean;
  metadataOnly?: boolean;
  previousIndexName?: string | null;
  currentIndexName?: string;
  unstable?: boolean;
  documentId?: string;
  revision?: string;
  documentSource?: MemoryDocumentSource;
  documentMetadata?: UnknownRecord;
  tags?: string[];
  /** Explicit query-time core tags for the native tag-retrieval backend. */
  coreTags?: string[];
  chunks?: string[];
  chunkEntries?: ChunkEntry[];
  tagEntries?: TagEntry[];
  fileId?: number | null;
  chunkIds?: number[];
  tagIds?: number[];
  removedChunkIds?: number[];
  orphanedTagIds?: number[];
  explicitRelations?: MemoryRelationRecord[];
  relationSourceKey?: string;
  relationSourceRevision?: string;
  query?: string;
  options?: SearchOptions | TdbSearchOptions;
  retrievalPlan?: RetrievalPlan;
  spaces?: string[];
  indexNames?: string[];
  libraries?: string[];
  resolvedIndexNames?: string[];
  scopeSource?: "call" | "config" | "authority" | "fallback";
  scopeWasExplicit?: boolean;
  allowedChunkIds?: Set<number>;
  allowedDocumentKeys?: Set<string>;
  topK?: number;
  queries?: QueryVector[];
  queryVector?: EmbeddingVector;
  vectorResults?: VectorResult[];
  bm25Results?: ChunkCandidate[];
  candidates?: SearchResult[];
  mergedCandidates?: ChunkCandidate[];
  results?: SearchResult[];
  resultCount?: number;
  failed?: boolean;
  tagResidualDecomposition?: TagResidualDecompositionData;
  tagBasisProjection?: TagBasisProjectionEnvelope;
  tagGraphPropagation?: TagGraphPropagationData;
  propagationSupport?: PropagationSupportData;
  propagationSupportSkipped?: boolean;
  propagationHistory?: PropagationHistoryData;
  propagationHistorySkipped?: boolean;
  associatorStats?: AssociatorStats;
  associatorSkipped?: boolean;
  propagationTrace?: PropagationTrace;
  vector?: EmbeddingVector;
  tagExpansion?: TagExpansionData;
  embeddingRerank?: EmbeddingRerankData;
  propagationStructure?: PropagationStructureData;
  dedupeStats?: DedupeStats;
  truncationStats?: TruncationStats;
  expansionStats?: ExpansionStats;
  tagRetrievalFailure?:
    "artifact_build_failed" | "backend_unavailable" | "invalid_result";
  nativeTagRetrievalFailure?:
    "native_backend_failed" | "artifact_unavailable" | "invalid_result";
  nativePropagationSupportFailure?:
    "backend_unavailable" | "artifact_unavailable" | "invalid_result";
}

export interface EmbeddingProviderContract {
  embedBatch(
    texts?: readonly string[],
    options?: EmbeddingOptions,
  ): Promise<(EmbeddingVector | null)[]>;
  embed?(
    text: string,
    options?: EmbeddingOptions,
  ): EmbeddingVector | Promise<EmbeddingVector | null>;
  getDimension(): number;
}

export interface EmbeddingOptions {
  textType?: string;
  [key: string]: unknown;
}

export interface VectorStoreStats {
  size: number;
  capacity: number;
  dimension: number;
  [key: string]: unknown;
}

export interface VectorIndexEntry {
  id: number;
  vector: VectorLike;
}

export interface VectorReconciliationPlan {
  indexEntries: Map<string, VectorIndexEntry[]>;
  expectedIndexNames: string[];
  rebuiltChunkCount: number;
  rebuiltTagCount: number;
  metadataChunkCount: number;
  skippedVectorCount: number;
}

export interface SearchCorpusChunk {
  id: number;
  content: string;
  indexName: string;
}

export interface VectorStoreContract {
  dimension?: number;
  add(indexName: string, id: number, vector: VectorLike): Promise<void>;
  addBatch(
    indexName: string,
    ids: readonly number[],
    vectors: readonly VectorLike[] | VectorLike,
  ): Promise<void>;
  search(indexName: string, queryVector: VectorLike, k: number): Promise<VectorHit[]>;
  remove(indexName: string, id: number): Promise<void>;
  loadIndex?(indexName: string, filePath: string): Promise<unknown>;
  saveIndex?(indexName: string, filePath: string): Promise<void>;
  getIndexStats?(indexName: string): Promise<VectorStoreStats>;
  scheduleIndexSave?(indexName: string): void;
  flushPendingSaves?(): void | Promise<void>;
  resetDerivedState?(): void | Promise<void>;
  rebuildDerivedState?(plan: VectorReconciliationPlan): void | Promise<void>;
  restorePersistedIndexes?(indexNames: readonly string[]): Promise<boolean>;
  replaceIndex?(
    indexName: string,
    entries: readonly VectorIndexEntry[],
  ): Promise<void> | void;
}

export interface ReconciliationReport {
  authoritative: "metadata";
  metadataChunks: number;
  usableVectors: number;
  skippedVectors: number;
  rebuiltIndexes: string[];
}

export interface FileRow {
  id: number;
  path: string;
  space: string;
  checksum: string;
  mtime: number;
  size: number;
  updated_at?: number | null;
  document_id?: string | null;
  revision?: string | null;
  source_json?: string | null;
  metadata_json?: string | null;
}

export interface ChunkRow {
  id: number;
  file_id?: number;
  fileId?: number;
  chunk_index?: number;
  chunkIndex?: number;
  content: string;
  vector?: Buffer | null;
}

export interface TagRow {
  id: number;
  name: string;
  vector: Buffer | Float32Array | null;
}

export interface FileTagRow {
  file_id?: number;
  fileId?: number;
  tag_id?: number;
  tagId?: number;
  position: number;
  id?: number;
  name?: string;
}

export type MemoryRelationKind = "explicit-link" | "derived-link" | "tag" | "sequence";
export type MemoryRelationOrigin = "source" | "derived";
export type MemoryRelationStatus = "active" | "stale" | "rejected";

export interface MemoryRelationRecord {
  id: string;
  from: string;
  to: string;
  kind: MemoryRelationKind;
  origin: MemoryRelationOrigin;
  confidence: number;
  weight: number;
  evidence?: string | null;
  provenance?: UnknownRecord | null;
  sourceRevision?: string | null;
  algorithmVersion?: string | null;
  sourceSpan?: { start: number; end: number } | null;
  targetAnchor?: string | null;
  createdAt: number;
  updatedAt: number;
  status: MemoryRelationStatus;
  active: boolean;
}

export interface RelationListOptions {
  from?: string;
  to?: string;
  origins?: readonly MemoryRelationOrigin[];
  kinds?: readonly MemoryRelationKind[];
  statuses?: readonly MemoryRelationStatus[];
  includeInactive?: boolean;
}

export interface RetrievalScopeFilters {
  spaces?: readonly string[];
  documentIds?: readonly string[];
  recordedAfter?: number | string;
  recordedBefore?: number | string;
  metadata?: Record<string, unknown>;
}

export interface RetrievalScopeResolution {
  allowedChunkIds: number[];
  allowedDocumentKeys: string[];
}

export interface RelationStoreContract {
  replaceExplicitRelations?(
    from: string,
    sourceRevision: string,
    relations: readonly MemoryRelationRecord[],
  ): Promise<void>;
  upsertDerivedRelations?(
    relations: readonly (Omit<
      MemoryRelationRecord,
      "id" | "origin" | "createdAt" | "updatedAt" | "status"
    > &
      Partial<
        Pick<
          MemoryRelationRecord,
          "id" | "origin" | "createdAt" | "updatedAt" | "status"
        >
      >)[],
  ): Promise<void>;
  listRelations?(options?: RelationListOptions): Promise<MemoryRelationRecord[]>;
  markExplicitRelationsStale?(from: string): Promise<void>;
  getRelationGeneration?(): Promise<number>;
  getRelationReadinessStats?(): Promise<{
    explicitLinks: number;
    activeInferredLinks: number;
  }>;
  getAdjacentRelations?(
    documentKeys: readonly string[],
  ): Promise<MemoryRelationRecord[]>;
}

export interface FileMetadataInput {
  path: string;
  space: string;
  checksum: string;
  mtime: number;
  size: number;
  documentId?: string;
  revision?: string;
  sourceJson?: string | null;
  metadataJson?: string | null;
}

export interface ChunkMetadataInput {
  chunkIndex: number;
  content: string;
  vector?: Buffer | null;
}

export interface TagMetadataInput {
  name: string;
  vector: Buffer | null;
}

export interface DocumentStateReplacement {
  file: {
    path: string;
    space: string;
    checksum: string;
    mtime: number;
    size: number;
    documentId?: string;
    revision?: string;
    sourceJson?: string | null;
    metadataJson?: string | null;
  };
  chunks: readonly {
    chunkIndex: number;
    content: string;
    vector: Buffer | null;
  }[];
  tags: readonly {
    name: string;
    vector: Buffer | null;
  }[];
  orderedTagNames: readonly string[];
  explicitRelations?: readonly MemoryRelationRecord[];
  relationSourceKey?: string;
  relationSourceRevision?: string;
  preserveChunks?: boolean;
  preserveTags?: boolean;
}

export interface DocumentStateReplacementResult {
  fileId: number;
  chunkIds: number[];
  tagIds: number[];
  removedChunkIds: number[];
  metadataGeneration: number;
  previousIndexName: string | null;
  currentIndexName: string;
  orphanedTagIds?: number[];
}

export interface DocumentTagReplacement {
  file: FileMetadataInput;
  tags: readonly TagMetadataInput[];
  orderedTagNames: readonly string[];
}

export interface DocumentTagReplacementResult {
  fileId: number;
  tagIds: number[];
  metadataGeneration: number;
  previousIndexName: string | null;
  currentIndexName: string;
  orphanedTagIds?: number[];
}

export interface HealthStatus {
  healthy: boolean;
  issues: string[];
}

export interface MetadataStoreContract extends RelationStoreContract {
  dimension?: number | null;
  upsertFile(fileMeta: FileMetadataInput): Promise<number | null>;
  updateDocumentMetadata?(input: FileMetadataInput): Promise<{
    fileId: number;
    changed: boolean;
  }>;
  countFiles(): Promise<number>;
  getAllFiles?(): Promise<FileRow[]>;
  getLastIndexedAt?(): Promise<number | null>;
  getFileByPath(path: string): Promise<FileRow | null>;
  getFileByDocumentId?(documentId: string): Promise<FileRow | null>;
  getDistinctSpaces(): Promise<string[]>;
  getFileByChunkId(chunkId: number): Promise<FileRow | null>;
  deleteFile(fileId: number): Promise<void>;
  insertChunks(
    fileId: number,
    chunks: readonly ChunkMetadataInput[],
  ): Promise<number[]>;
  replaceDocumentState(
    replacement: DocumentStateReplacement,
  ): Promise<DocumentStateReplacementResult>;
  /** Atomic authority replacement including source-relation history. */
  replaceDocumentAuthority?(
    replacement: DocumentStateReplacement & {
      relationSourceKey: string;
      relationSourceRevision: string;
      explicitRelations: readonly MemoryRelationRecord[];
    },
  ): Promise<DocumentStateReplacementResult>;
  deleteDocumentAuthority?(input: {
    path: string;
    documentId?: string;
    relationSourceKeys?: readonly string[];
  }): Promise<{
    removed: boolean;
    fileId: number | null;
    chunkIds: number[];
    orphanedTagIds: number[];
  }>;
  replaceDocumentTags?(
    replacement: DocumentTagReplacement,
  ): Promise<DocumentTagReplacementResult>;
  getChunksByFileId(fileId: number): Promise<ChunkRow[]>;
  getChunkById(id: number): Promise<ChunkRow | null>;
  getAllChunks(): Promise<ChunkRow[]>;
  getSearchCorpus?(indexNames?: readonly string[]): Promise<SearchCorpusChunk[]>;
  getIndexableChunks?(): Promise<IndexableChunkRow[]>;
  getExpectedVectorIndexNames?(): Promise<string[]>;
  getGenerationState?(): Promise<GenerationState>;
  markVectorStateClean?(): Promise<void>;
  upsertTags(tags: readonly TagMetadataInput[]): Promise<number[]>;
  getTagByName(name: string): Promise<TagRow | null>;
  getAllTags(): Promise<TagRow[]>;
  getActiveTags?(): Promise<TagRow[]>;
  resolveRetrievalScope?(
    filters: RetrievalScopeFilters,
    indexNames?: readonly string[],
  ): Promise<RetrievalScopeResolution>;
  setFileTags(fileId: number, tagIds: readonly number[]): Promise<void>;
  getFileTags(fileId: number): Promise<FileTagRow[]>;
  getFileIdsByTagId(tagId: number): Promise<number[]>;
  buildCooccurrenceMatrix(): Promise<Map<number, Map<number, number>>>;
  checkpoint(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
  setKv?(key: string, value: string): Promise<void>;
  getKv?(key: string): Promise<string | UnknownRecord | null>;
  getTagsByIds?(ids: readonly number[]): Promise<TagRow[]>;
}

export interface IndexableChunkRow {
  chunkId: number;
  vector: Buffer | null;
  indexName: string;
}

export interface GenerationState {
  metadataGeneration: number;
  vectorGeneration: number;
  vectorDirty: boolean;
}

export interface StatementLike {
  get(...params: readonly unknown[]): unknown;
  all?(...params: readonly unknown[]): unknown;
  run?(...params: readonly unknown[]): unknown;
}

export interface DatabaseLike {
  prepare(sql: string): StatementLike;
  exec?(sql: string): unknown;
  pragma?(sql: string, options?: UnknownRecord): unknown;
  close?(): void;
}

export interface TagBasisProjectionResult {
  projections: Float32Array | null;
  probabilities: Float32Array | null;
  entropy: number;
  projectionConcentration: number;
  dominantAxes: TagBasisDominantAxis[];
}

export interface TagBasisProjectionLike {
  initialized: boolean;
  project(vector: VectorLike): TagBasisProjectionResult;
  detectCrossDomainAxisCoactivation(vector: VectorLike): {
    axisCoactivation: number;
    coactiveAxisPairs: UnknownRecord[];
    [key: string]: unknown;
  };
}

export interface PipelineContextOptions {
  config: MemoryConfigOverrides;
  embeddingProvider?: EmbeddingProviderContract | null;
  vectorStore?: VectorStoreContract | null;
  metadataStore?: MetadataStoreContract | null;
  /** Internal tag-retrieval backend injected by engine construction. */
  tagRetrievalRuntime?: unknown;
  tagBasisProjection?: TagBasisProjectionLike;
  propagationHistoryStore?: PropagationHistoryStore;
  tagAssociationGraph?: Map<number, Map<number, number>>;
  reranker?: ExternalReranker;
  queryInterpreter?: {
    interpret(
      query: string,
    ): Promise<Record<string, unknown>> | Record<string, unknown>;
  };
}

export interface Stage<Input = PipelineData, Output = PipelineData> {
  readonly name?: string;
  process(input: Input, ctx: PipelineContextLike): Promise<Output>;
}

export interface PipelineContextLike {
  config: MemoryConfigOverrides;
  embeddingProvider?: EmbeddingProviderContract | null;
  vectorStore?: VectorStoreContract | null;
  metadataStore?: MetadataStoreContract | null;
  /** Internal native tag-retrieval runtime handle. */
  tagRetrievalRuntime?: unknown;
  tagBasisProjection?: TagBasisProjectionLike;
  propagationHistoryStore?: PropagationHistoryStore;
  tagAssociationGraph?: Map<number, Map<number, number>>;
  checkpointState?: { fileCount: number; spaces: Set<string> };
  reranker?: ExternalReranker;
  queryInterpreter?: {
    interpret(
      query: string,
    ): Promise<Record<string, unknown>> | Record<string, unknown>;
  };
}

export type StageInput = PipelineData;
export type StageOutput = PipelineData;

export interface TdbSearchResult extends SearchResult {
  library: string;
  path: string;
  text: string;
  title?: string;
  _expanded?: boolean;
}

export interface TdbSearchEnvelope extends Omit<
  SearchEnvelope,
  "results" | "resultCount"
> {
  results: TdbSearchResult[];
  resultCount: number;
  tdbDisabled?: boolean;
  [key: string]: unknown;
}

export interface TdbIngestEnvelope extends UnknownRecord {
  skipped: boolean;
  disabled?: boolean;
  reason?: string;
  library?: string;
  path?: string;
  fileId?: number | null;
  checksum?: string;
  chunkCount?: number;
  fileSize?: number;
  nodeIds?: number[];
}

export interface TdbDeleteEnvelope extends UnknownRecord {
  removed: boolean;
  disabled?: boolean;
  library?: string;
  path?: string;
  fileId?: number;
  removedChunkIds?: number[];
  removedNodeIds?: number[];
}

export interface TdbStats extends UnknownRecord {
  enabled: boolean;
  initialized: boolean;
  files: number;
  chunks: number;
  libraries: string[];
  storePath: string;
  rootPath: string;
}

export interface TdbFileRow {
  id: number;
  library: string;
  path: string;
  checksum: string;
  mtime: number;
  size: number;
  doc_node_id?: number | null;
  updated_at?: number | null;
  docNodeId?: number | null;
  updatedAt?: number | null;
}

export interface TdbChunkRow {
  id: number;
  library: string;
  path: string;
  chunkIndex: number;
  nodeId: number;
  text: string;
  checksum: string;
  vector?: Buffer | null;
}

export interface TdbChunkInput {
  text: string;
  checksum: string;
  vector?: Buffer | null;
}

export interface TdbInsertedChunk {
  chunkId: number;
  nodeId: number;
}

export interface TdbCorpusChunk {
  id: number;
  content: string;
  indexName?: string;
}

export interface TdbDocumentStateReplacement {
  file: {
    library: string;
    path: string;
    checksum: string;
    mtime: number;
    size: number;
    updatedAt: number;
  };
  chunks: readonly {
    text: string;
    checksum: string;
    vector: Buffer | null;
  }[];
}

export interface TdbDocumentStateReplacementResult {
  fileId: number;
  chunkIds: number[];
  nodeIds: number[];
  removedChunkIds: number[];
  removedNodeIds: number[];
  metadataGeneration: number;
}

export interface TdbDeleteDocumentStateResult {
  removed: boolean;
  fileId: number | null;
  chunkIds: number[];
  nodeIds: number[];
  metadataGeneration: number;
}

export interface TdbGenerationState {
  metadataGeneration: number;
  vectorGeneration: number;
  vectorDirty: boolean;
}

export interface TdbRebuildChunk {
  chunkId: number;
  nodeId: number;
  library: string;
  text: string;
  vector: Buffer | null;
}

export interface TdbStoreContract {
  dbPath: string;
  busyTimeout: number;
  upsertFile(meta: {
    library: string;
    path: string;
    checksum: string;
    mtime: number;
    size: number;
    docNodeId?: number | null;
    updatedAt?: number;
  }): Promise<number | null>;
  getFile(library: string, path: string): Promise<TdbFileRow | null>;
  getFileById(id: number): Promise<TdbFileRow | null>;
  getFileByChunkId(chunkId: number): Promise<TdbFileRow | null>;
  deleteFile(
    library: string,
    path: string,
  ): Promise<{ chunkIds: number[]; nodeIds: number[] }>;
  replaceDocumentState(
    replacement: TdbDocumentStateReplacement,
  ): Promise<TdbDocumentStateReplacementResult>;
  deleteDocumentState(
    library: string,
    path: string,
  ): Promise<TdbDeleteDocumentStateResult>;
  insertChunks(
    library: string,
    path: string,
    chunks: readonly TdbChunkInput[],
  ): Promise<TdbInsertedChunk[]>;
  getChunks(library: string, path: string): Promise<TdbChunkRow[]>;
  getChunkById(id: number): Promise<TdbChunkRow | null>;
  getAllChunks(): Promise<TdbCorpusChunk[]>;
  getSearchCorpus(libraries?: readonly string[]): Promise<SearchCorpusChunk[]>;
  getExpectedVectorIndexNames(): Promise<string[]>;
  getTdbGenerationState(): Promise<TdbGenerationState>;
  markTdbVectorStateClean(): Promise<void>;
  getTdbRebuildChunks(): Promise<TdbRebuildChunk[]>;
  updateChunkVectors(
    entries: readonly { chunkId: number; vector: Buffer | null }[],
  ): Promise<void>;
  countFiles(): Promise<number>;
  listLibraries(): Promise<string[]>;
  getDistinctSpaces(): Promise<string[]>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
  close(): void;
}

export interface TdbEngineOptions {
  config?: MemoryConfigOverrides;
  metadataStore?: TdbStoreContract;
  vectorStore?: VectorStoreContract;
  embeddingProvider?: EmbeddingProviderContract;
  trivium?: TriviumDBContract;
  searchOptions?: TdbSearchOptions;
}

export interface TdbSearchOptions {
  libraries?: string[];
  topK?: number;
  minScore?: number;
  hybridAlpha?: number;
  expand?: boolean;
  expandDepth?: number;
  path?: string;
  library?: string;
  title?: string;
  now?: number;
  mtime?: number;
  size?: number;
}

export interface TriviumSearchHit {
  id: number;
  score: number;
  payload?: UnknownRecord;
}

export interface TriviumDBContract {
  insert?(
    vector: VectorLike,
    payload?: UnknownRecord,
    options?: UnknownRecord,
  ): Promise<number | null>;
  submit?(
    vector: VectorLike,
    payload?: UnknownRecord,
    options?: UnknownRecord,
  ): Promise<number | null>;
  delete?(nodeId: number, options?: UnknownRecord): Promise<void>;
  search(
    queryVector: VectorLike,
    k?: number,
    options?: UnknownRecord,
  ): Promise<TriviumSearchHit[]>;
  searchHybrid?(
    queryVector: VectorLike,
    queryText: string,
    k?: number,
    expandDepth?: number,
    minScore?: number,
    alpha?: number,
    options?: UnknownRecord,
  ): Promise<TriviumSearchHit[]>;
  flush?(): Promise<void>;
  stats?(options?: UnknownRecord): Promise<UnknownRecord>;
}

/** Public names retained for consumers of the original JavaScript API. */
export type EmbeddingProvider = EmbeddingProviderContract;
export type MetadataStore = MetadataStoreContract;
export type VectorStore = VectorStoreContract;
