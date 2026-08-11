import type { RetrievalPlan, RetrievalPlanInput } from "./retrieval/retrieval-plan.js";
import type { RetrievalStrategySource } from "./retrieval/query-planner.js";

/** A vector accepted at the public boundary before it is normalised. */
export type VectorLike = Float32Array | readonly number[];
export type Vector = Float32Array;
export type EmbeddingVector = VectorLike;

export type UnknownRecord = Record<string, unknown>;

export interface SourcePriority {
  rag?: number;
  time?: number;
  bm25_body?: number;
  bm25_tag?: number;
  continuity?: number;
  associate?: number;
  unknown?: number;
  [source: string]: number | undefined;
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
  tagIndexCapacity: number;
  indexSaveDelay: number;
  tagIndexSaveDelay: number;
  persistTagIndex: boolean;
  indexLoadEnabled?: boolean;
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
  epaProjectionEnabled: boolean;
  residualPyramidEnabled: boolean;
  tagMemoV9Enabled: boolean;
  tagMemoV10Enabled: boolean;
  riverMemoEnabled: boolean;
  topologyV3Enabled: boolean;
  nativeMemoEnabled: boolean;
  tagExpansionEnabled: boolean;
  vectorReshapeEnabled: boolean;
  geodesicRerankEnabled: boolean;
  geodesicAlpha: number;
  geodesicMinGeoSamples: number;
  associatorEnabled: boolean;
  externalRerankEnabled: boolean;
  useLLMRerank: boolean;
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
  tagIndexName: string;
  tagK: number;
  queryExpansion: number;
  queryEpsilon: number | null;
  epsilon: number | null;
  rephraserFn: QueryRephraser | null;
  queryRephraserFn: QueryRephraser | null;
  stopWords: string[];
  tokenizer: Tokenizer | null;
  bm25K1: number;
  bm25B: number;
  bm25PoolK: number;
  minScore: number;
  vectorWeight: number;
  bm25Weight: number;
  hybridAlpha: number;
  hybridBeta: number;
  dedupeEnabled: boolean;
  dedupeSemantic: boolean;
  semanticThreshold: number;
  dedupeMaxResults: number;
  minSemanticCandidates: number;
  maxResults: number;
  sourcePriority: SourcePriority;
  reranker: ExternalReranker | null;
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
  epaClusterCount: number;
  epaMaxBasisDim: number;
  epaPerCandidateAnalysis: boolean;
  strictOrthogonalization: boolean;
  pyramidMaxLevels: number;
  pyramidTopK: number;
  pyramidMinEnergyRatio: number;
  minEnergyRatio: number;
  maxLevels: number;
  maxSafeHops: number;
  baseMomentum: number;
  momentum: number;
  firingThreshold: number;
  baseDecay: number;
  wormholeDecay: number;
  tensionThreshold: number;
  maxNeighborsPerNode: number;
  branchLimit: number;
  returnFlowFactor: number;
  firGamma: number;
  maxPropagationStates: number;
  stateLimit: number;
  pruneAbove: number;
  localAlpha: number;
  transferAlpha: number;
  localMaxIterations: number;
  transferMaxIterations: number;
  solverMaxIterations: number;
  solverTolerance: number;
  supportMethod: string;
  localMassRatio: number;
  transferMassRatio: number;
  pruneByEnergy: boolean;
  minFieldEnergy: number;
  riverDecay: number;
  riverTopologyCap: number;
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

  // Compatibility knobs consumed by older adapters and persisted configs.
  finalSemanticThreshold?: number;
  tagExpansionBoost?: number;
  tagExpansionTopK?: number;
  v91FirGamma?: number;
  v91ReturnFlowFactor?: number;
  env?: UnknownRecord;
  textType?: string;
  timeoutMs?: number;
  tdbForceMode?: string;
  /** @deprecated Compatibility escape hatch; the concrete native type is internal. */
  vexusIndex?: unknown;
  [key: string]: unknown;
}

export type MemoryConfigOverrides = Partial<MemoryConfig> & UnknownRecord;

export interface MemoryEngineOptions {
  config?: MemoryConfigOverrides;
  /** Fixed per-engine retrieval defaults; normalized at construction time. */
  defaultRetrievalPlan?: RetrievalPlanInput;
  dbPath?: string;
  ragParamsPath?: string;
  ragParams?: UnknownRecord;
  embeddingProvider?: EmbeddingProviderContract;
  vectorStore?: VectorStoreContract;
  metadataStore?: MetadataStoreContract;
  ctx?: PipelineContextOptions;
  ingestOptions?: UnknownRecord;
  deleteOptions?: UnknownRecord;
  searchOptions?: UnknownRecord;
  onReady?: (engine: unknown) => void | Promise<void>;
}

export interface SearchOptions extends UnknownRecord {
  retrievalPlan?: RetrievalPlanInput;
  inheritRetrievalDefaults?: boolean;
}

/** Host-neutral provenance attached to a logical memory document. */
export interface MemoryDocumentSource extends UnknownRecord {
  type?: string;
  id?: string;
}

/** Content-centered ingestion input. It deliberately has no filesystem path. */
export interface MemoryDocumentInput {
  id: string;
  content: string;
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
  /** Optional raw source snapshot; content may be a parsed/body projection. */
  sourceContent?: string;
  mtime?: number;
  size?: number;
  documentId?: string;
  revision?: string;
  documentSource?: MemoryDocumentSource;
  documentMetadata?: UnknownRecord;
  diaryName?: string;
}

export interface FileSnapshot extends Omit<
  Required<FileInput>,
  | "documentId"
  | "revision"
  | "documentSource"
  | "documentMetadata"
  | "diaryName"
  | "sourceContent"
> {
  relPath: string;
  content: string;
  sourceContent?: string;
  mtime: number;
  size: number;
  diaryName: string;
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
  [key: string]: unknown;
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
  diaryName?: string;
  fileId?: number | null;
  chunkIndex?: number | null;
  payload?: UnknownRecord;
  tags?: string[];
  documentId?: string;
  revision?: string;
  sourceMetadata?: MemoryDocumentSource;
  metadata?: UnknownRecord;
  associationChannel?: "tag" | "vector";
  associationOf?: number;
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
  embeddingSim?: number;
  topologyBonus?: number;
  topologyRaw?: number;
  topologyReliability?: number;
  domainHits?: number[];
  [key: string]: unknown;
}

export interface SearchEnvelope {
  query?: string;
  tokens?: string[];
  options?: SearchOptions;
  queries?: QueryVector[];
  queryVector?: EmbeddingVector;
  vectorResults?: VectorResult[];
  bm25Results?: ChunkCandidate[];
  candidates?: SearchResult[];
  results: SearchResult[];
  resultCount: number;
  tagMemo?: TagMemoData;
  geodesic?: GeodesicData;
  geodesicSkipped?: boolean;
  associatorStats?: AssociatorStats;
  associatorSkipped?: boolean;
  pyramid?: PyramidData;
  epa?: EpaEnvelope;
  tagExpansion?: TagExpansionData;
  vectorReshape?: VectorReshapeData;
  riverMemo?: RiverMemoData;
  dedupeStats?: DedupeStats;
  truncationStats?: TruncationStats;
  expansionStats?: ExpansionStats;
  reranked?: boolean;
  rerankSkipped?: boolean;
  rerankFailure?: "provider_error";
  /** Compatibility field; runtime values are stable safe error codes. */
  rerankError?: string;
  nativeMemoFailure?:
    "artifact_build_failed" | "backend_unavailable" | "invalid_result";
  topologyV3Failure?:
    "native_backend_failed" | "artifact_unavailable" | "invalid_result";
  nativeGeodesicFailure?:
    "backend_unavailable" | "artifact_unavailable" | "invalid_result";
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
  [key: string]: unknown;
}

export interface RiverGraph {
  nodes: UnknownRecord[];
  edges: UnknownRecord[];
  diagnostics: UnknownRecord;
  [key: string]: unknown;
}

export interface RiverStateStore {
  getKv(key: string): Promise<string | UnknownRecord | null>;
  setKv(key: string, value: string): Promise<void>;
}

export interface RiverObservabilityResult extends UnknownRecord {
  omega: number;
  regime: string;
}

export interface EpaQueryAnalysis {
  logicDepth: number;
  entropy: number;
  dominantAxes: EpaDominantAxis[];
  resonance: {
    resonance: number;
    bridges: UnknownRecord[];
    [key: string]: unknown;
  };
}

export interface EpaEnvelope {
  ready: boolean;
  queryAnalysis: EpaQueryAnalysis;
  candidateAnalyses: UnknownRecord[];
}

export interface PyramidFeatures {
  depth: number;
  coverage: number;
  novelty: number;
  coherence: number;
  tagMemoActivation: number;
  expansionSignal?: number;
}

export interface PyramidTag {
  id: number;
  name?: string | null;
  contribution?: number;
  isCore?: boolean;
}

export interface PyramidLevel {
  tags: PyramidTag[];
}

export interface PyramidData {
  levels: PyramidLevel[];
  totalExplainedEnergy?: number;
  finalResidual?: Vector | null;
  features?: PyramidFeatures;
}

export interface TagMemoData extends UnknownRecord {
  version?: string;
  activations?: Map<number, number>;
  ranked?: UnknownRecord[];
  sourceField?: ReadonlyArray<readonly [number, number]>;
  localField?: ReadonlyArray<readonly [number, number]>;
  transferField?: ReadonlyArray<readonly [number, number]>;
  riverGraph?: RiverGraph;
  pruneThreshold?: number;
  prunedFieldEntries?: number;
  pruneSkipped?: boolean;
  solverDiagnostics?: UnknownRecord & {
    iterations?: number;
    prunedNodeCount?: number;
    converged?: boolean;
  };
  iterations?: number;
  localDomain?: { ids: readonly number[]; [key: string]: unknown };
  transferDomain?: { ids: readonly number[]; [key: string]: unknown };
  rankedTags?: unknown[];
}

export interface TagExpansionData {
  added: number[];
  boosted: number[];
}

export interface VectorReshapeData {
  enabled: boolean;
  traced: { checked: number; matched: number; skipped: number };
}

export interface GeodesicData {
  version: "ts-v1" | "rust-dtsc-v1";
  alpha: number;
  minGeoSamples: number;
  appliedCount: number;
  degradedCount: number;
  native?: boolean;
  schema?: string;
  algorithmVersion?: string;
  diagnostics?: UnknownRecord;
  scores: Array<{
    chunkId: number;
    originalScore: number;
    geoScore: number;
    normalizedGeoScore: number;
    finalScore: number;
    hitCount: number;
  }>;
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

export interface RiverMemoData extends UnknownRecord {
  regime?: string;
  omega?: number;
  entropy?: number;
  nodeCount?: number;
  edgeCount?: number;
  nodeTotals?: Record<string, number>;
  rerankedCount?: number;
  tickFlowMass?: number;
  activeEdges?: number;
  [key: string]: unknown;
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
  /** Immutable source snapshot used by derived-link extraction; never embedded. */
  sourceContent?: string;
  mtime?: number;
  size?: number;
  diaryName?: string;
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
  /** Explicit query-time core tags for native Memo compatibility callers. */
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
  options?: SearchOptions;
  retrievalPlan?: RetrievalPlan;
  diaryNames?: string[];
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
  pyramid?: PyramidData;
  epa?: EpaEnvelope;
  tagMemo?: TagMemoData;
  geodesic?: GeodesicData;
  geodesicSkipped?: boolean;
  associatorStats?: AssociatorStats;
  associatorSkipped?: boolean;
  riverGraph?: RiverGraph;
  vector?: EmbeddingVector;
  tagExpansion?: TagExpansionData;
  vectorReshape?: VectorReshapeData;
  riverMemo?: RiverMemoData;
  dedupeStats?: DedupeStats;
  truncationStats?: TruncationStats;
  expansionStats?: ExpansionStats;
  nativeMemoFailure?:
    "artifact_build_failed" | "backend_unavailable" | "invalid_result";
  topologyV3Failure?:
    "native_backend_failed" | "artifact_unavailable" | "invalid_result";
  nativeGeodesicFailure?:
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
  diary_name: string;
  diaryName?: string;
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
  diaryName: string;
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
    diaryName: string;
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
  /** Exposed for compatibility diagnostics used by the legacy tests/callers. */
  _closed?: boolean;
  upsertFile(fileMeta: FileMetadataInput): Promise<number | null>;
  updateDocumentMetadata?(input: FileMetadataInput): Promise<{
    fileId: number;
    changed: boolean;
  }>;
  countFiles?(): Promise<number>;
  getAllFiles?(): Promise<FileRow[]>;
  getLastIndexedAt?(): Promise<number | null>;
  getFileByPath(path: string): Promise<FileRow | null>;
  getFileByDocumentId?(documentId: string): Promise<FileRow | null>;
  getDistinctDiaryNames(): Promise<string[]>;
  getFileByChunkId(chunkId: number): Promise<FileRow | null>;
  deleteFile(fileId: number): Promise<void>;
  insertChunks(
    fileId: number,
    chunks: readonly ChunkMetadataInput[],
  ): Promise<number[]>;
  replaceDocumentState?(
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

export interface EpaProjectResult {
  projections: Float32Array | null;
  probabilities: Float32Array | null;
  entropy: number;
  logicDepth: number;
  dominantAxes: EpaDominantAxis[];
}

export interface EpaAnalysis {
  logicDepth: number;
  resonance: number;
  entropy: number;
  dominantAxes: EpaDominantAxis[];
}

export interface TagBoostEnvelope extends UnknownRecord {
  vector: Float32Array;
  info: {
    matchedTags: string[];
    coreTagsMatched: string[];
    boostFactor: number;
    tagBoost: number;
    tagMatchScore: number;
  };
  energyField: unknown;
  energyFieldProvenance: unknown;
  artifactBundle: unknown;
  preparedMemoObservation: unknown;
}

export interface EpaDominantAxis {
  index: number;
  label?: string;
  energy: number;
  projection: number;
}

export interface EpaLike {
  initialized: boolean;
  project(vector: VectorLike): EpaProjectResult;
  detectCrossDomainResonance(vector: VectorLike): {
    resonance: number;
    bridges: UnknownRecord[];
    [key: string]: unknown;
  };
}

export interface PipelineContextOptions {
  config: MemoryConfigOverrides;
  embeddingProvider?: EmbeddingProviderContract | null;
  vectorStore?: VectorStoreContract | null;
  metadataStore?: MetadataStoreContract | null;
  /** @deprecated Compatibility escape hatch; the concrete native type is internal. */
  vexusIndex?: unknown;
  epa?: EpaLike;
  riverStateStore?: RiverStateStore;
  tagGraph?: Map<number, Map<number, number>>;
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
  /** @deprecated Compatibility escape hatch; the concrete native type is internal. */
  vexusIndex?: unknown;
  epa?: EpaLike;
  riverStateStore?: RiverStateStore;
  tagGraph?: Map<number, Map<number, number>>;
  checkpointState?: { fileCount: number; diaries: Set<string> };
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
}

export interface TdbSearchEnvelope extends Omit<
  PipelineData,
  "results" | "resultCount"
> {
  results: TdbSearchResult[];
  resultCount: number;
  tdbDisabled?: boolean;
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
  db: DatabaseLike;
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
  getDistinctDiaryNames(): Promise<string[]>;
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

export interface TdbSearchOptions extends UnknownRecord {
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
