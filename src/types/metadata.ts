import type { UnknownRecord } from "./common.js";
import type { MemoryRelationRecord, RelationStoreContract } from "./relations.js";
import type {
  PropagationHistoryObservation,
  PropagationHistorySnapshot,
} from "./retrieval.js";
import type { SearchCorpusChunk } from "./vector.js";

export interface FileRow {
  id: number;
  path: string;
  space: string;
  checksum: string;
  source_updated_at: number;
  size: number;
  recorded_at?: number | null;
  indexed_at?: number | null;
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

export interface FileMetadataInput {
  path: string;
  space: string;
  checksum: string;
  sourceUpdatedAt: number;
  recordedAt?: number;
  indexedAt?: number;
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
    sourceUpdatedAt: number;
    recordedAt?: number;
    indexedAt?: number;
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
  readPropagationHistory?(
    nodeIds: readonly number[],
  ): Promise<PropagationHistorySnapshot>;
  commitPropagationObservation?(
    observation: PropagationHistoryObservation,
  ): Promise<PropagationHistorySnapshot>;
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

export type MetadataStore = MetadataStoreContract;
