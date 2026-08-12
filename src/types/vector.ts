import type { VectorLike } from "./common.js";
import type { VectorHit } from "./documents.js";

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

export type VectorStore = VectorStoreContract;
