import type {
  EmbeddingVector,
  ExternalReranker,
  UnknownRecord,
  VectorLike,
} from "./common.js";
import type { MemoryConfigOverrides, SearchOptions } from "./config.js";
import type {
  ChunkEntry,
  MemoryDocumentFormat,
  MemoryDocumentSource,
  QueryVector,
  SearchResult,
  TagEntry,
  VectorResult,
} from "./documents.js";
import type { EmbeddingProviderContract } from "./embedding.js";
import type { MetadataStoreContract } from "./metadata.js";
import type { MemoryRelationRecord } from "./relations.js";
import type { VectorStoreContract } from "./vector.js";
import type {
  AssociatorStats,
  DedupeStats,
  EmbeddingRerankData,
  ExpansionStats,
  PropagationHistoryData,
  PropagationHistoryObservation,
  PropagationStructureData,
  PropagationSupportData,
  PropagationTrace,
  TagBasisProjectionEnvelope,
  TagGraphPropagationData,
  TagExpansionData,
  TagResidualDecompositionData,
  TruncationStats,
  PropagationHistoryStore,
  TagBasisDominantAxis,
} from "./retrieval.js";
import type { RetrievalDiagnostics } from "./documents.js";
import type { TdbSearchOptions } from "./tdb.js";
import type { TagRetrievalObservation } from "../stages/tag-retrieval/tag-retrieval-observation.js";

/** The common object flowing between ordinary pipeline stages. */
export interface PipelineData extends UnknownRecord {
  path?: string;
  relPath?: string;
  content?: string;
  format?: MemoryDocumentFormat;
  /** Immutable source snapshot used by derived-link extraction; never embedded. */
  sourceContent?: string;
  sourceUpdatedAt?: number;
  recordedAt?: number;
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
  retrievalPlan?: import("../retrieval/retrieval-plan.js").RetrievalPlan;
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
  bm25Results?: import("./documents.js").ChunkCandidate[];
  candidates?: SearchResult[];
  mergedCandidates?: import("./documents.js").ChunkCandidate[];
  results?: SearchResult[];
  resultCount?: number;
  failed?: boolean;
  tagResidualDecomposition?: TagResidualDecompositionData;
  tagBasisProjection?: TagBasisProjectionEnvelope;
  tagGraphPropagation?: TagGraphPropagationData;
  propagationSupport?: PropagationSupportData;
  propagationSupportSkipped?: boolean;
  propagationHistory?: PropagationHistoryData;
  /** Internal post-read observation committed after the stable-read phase. */
  propagationHistoryObservation?: PropagationHistoryObservation;
  /** Internal unified native/TypeScript tag-retrieval observation. */
  tagRetrievalObservation?: TagRetrievalObservation;
  propagationHistorySkipped?: boolean;
  associatorStats?: AssociatorStats;
  associatorSkipped?: boolean;
  propagationTrace?: PropagationTrace;
  vector?: EmbeddingVector;
  tagExpansion?: TagExpansionData;
  embeddingRerank?: EmbeddingRerankData;
  propagationStructure?: PropagationStructureData;
  /** Stable diagnostics projected from the internal stage trace. */
  retrieval?: RetrievalDiagnostics;
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
  loadTagAssociationGraph?: () => Promise<Map<number, Map<number, number>>>;
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
  loadTagAssociationGraph?: () => Promise<Map<number, Map<number, number>>>;
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
