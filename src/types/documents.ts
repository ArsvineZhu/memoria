import type { RetrievalPlan } from "../retrieval/retrieval-plan.js";
import type { RetrievalStrategySource } from "../retrieval/query-planner.js";
import type { TdbSearchOptions } from "./tdb.js";
import type { EmbeddingVector, UnknownRecord, VectorLike } from "./common.js";
import type { SearchOptions } from "./config.js";

export type RetrievalEvidenceChannel =
  | "semantic"
  | "lexical"
  | "tag-association"
  | "relation-expansion"
  | "support"
  | "structure";

export interface RetrievalEvidence {
  channel: RetrievalEvidenceChannel;
  available: boolean;
}

export type RetrievalFallbackReason =
  | "capability-unavailable"
  | "backend-unavailable"
  | "native-backend-failed"
  | "artifact-unavailable"
  | "history-persistence-failed"
  | "provider-error"
  | "invalid-result"
  | "disabled-by-plan";

export interface RetrievalDiagnostics {
  strategy: string;
  strategySource?: RetrievalStrategySource;
  plan: RetrievalPlan;
  evidence: RetrievalEvidence[];
  fallbacks: RetrievalFallbackReason[];
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
  /** When the memory itself was recorded, as Unix epoch milliseconds. */
  recordedAt?: number;
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
  /** Optional raw source snapshot; the ingest pipeline owns any projection. */
  sourceContent?: string;
  /** Last source modification time, as Unix epoch milliseconds. */
  sourceUpdatedAt?: number;
  /** When the memory was recorded, as Unix epoch milliseconds. */
  recordedAt?: number;
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
  sourceUpdatedAt: number;
  recordedAt: number;
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
  sourceUpdatedAt?: number | null;
  recordedAt?: number | null;
  indexedAt?: number | null;
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
  options?: SearchOptions | TdbSearchOptions;
  results: SearchResult[];
  resultCount: number;
  retrieval?: RetrievalDiagnostics;
  failed?: boolean;
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
