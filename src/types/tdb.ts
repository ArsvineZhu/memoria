import type { MemoryConfigOverrides } from "./config.js";
import type { UnknownRecord, VectorLike } from "./common.js";
import type { SearchEnvelope, SearchResult } from "./documents.js";
import type { EmbeddingProviderContract } from "./embedding.js";
import type { HealthStatus } from "./metadata.js";
import type { SearchCorpusChunk, VectorStoreContract } from "./vector.js";

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
  source_updated_at: number;
  size: number;
  doc_node_id?: number | null;
  recorded_at: number;
  indexed_at: number;
  docNodeId?: number | null;
  sourceUpdatedAt?: number | null;
  recordedAt?: number | null;
  indexedAt?: number | null;
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
    sourceUpdatedAt: number;
    recordedAt?: number;
    indexedAt?: number;
    size: number;
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
    sourceUpdatedAt: number;
    size: number;
    docNodeId?: number | null;
    recordedAt?: number;
    indexedAt?: number;
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
  recordedAt?: number;
  sourceUpdatedAt?: number;
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
