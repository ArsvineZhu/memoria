"use strict";

import VectorStore from "../interfaces/vector-store.js";
import type { VexusIndex } from "../native/vexus-lite.js";
import type { VectorIndexEntry, VectorStoreStats } from "../types/vector.js";
import type { VectorLike } from "../types/common.js";
import type { VectorHit } from "../types/documents.js";
import {
  at,
  assertDimension,
  assertFiniteVector,
  assertVectorDimension,
} from "../utils/numerical.js";
import { createVexusIndex, parseNativeSearchResults } from "./vexus-native-bridge.js";
import { VexusIndexPersistence } from "./vexus-index-persistence.js";

interface VexusStoreConfig {
  dimension?: number;
  storePath?: string;
  tagVectorIndexCapacity?: number;
  indexSaveDelay?: number;
  tagVectorIndexSaveDelay?: number;
  persistTagVectorIndex?: boolean;
  indexLoadEnabled?: boolean;
}

/** VectorStore facade for validated vector operations over Vexus indexes. */
class VexusVectorStore extends VectorStore {
  dimension: number;
  storePath: string;
  defaultCapacity: number;
  indexSaveDelay: number;
  tagVectorIndexSaveDelay: number;
  persistTagVectorIndex: boolean;
  indexLoadEnabled: boolean;
  indices: Map<string, VexusIndex>;
  saveTimers: Map<string, NodeJS.Timeout>;

  private readonly persistence: VexusIndexPersistence;

  constructor(config: VexusStoreConfig = {}) {
    super();
    this.dimension = config.dimension ?? 3072;
    assertDimension(this.dimension, "Vexus vector dimension");
    this.storePath = config.storePath ?? ".";
    this.defaultCapacity = config.tagVectorIndexCapacity ?? 50000;
    this.indexSaveDelay = config.indexSaveDelay ?? 5000;
    this.tagVectorIndexSaveDelay = config.tagVectorIndexSaveDelay ?? 10000;
    this.persistTagVectorIndex = config.persistTagVectorIndex ?? false;
    this.indexLoadEnabled = config.indexLoadEnabled !== false;
    this.indices = new Map();
    this.saveTimers = new Map();
    this.persistence = new VexusIndexPersistence({
      dimension: this.dimension,
      storePath: this.storePath,
      defaultCapacity: this.defaultCapacity,
      indexSaveDelay: this.indexSaveDelay,
      tagVectorIndexSaveDelay: this.tagVectorIndexSaveDelay,
      persistTagVectorIndex: this.persistTagVectorIndex,
      indexLoadEnabled: this.indexLoadEnabled,
      indices: this.indices,
      saveTimers: this.saveTimers,
    });
  }

  getOrCreateIndex(indexName: string, capacity = this.defaultCapacity): VexusIndex {
    return this.persistence.getOrCreateIndex(indexName, capacity);
  }

  _indexFileExists(indexName: string): boolean {
    return this.persistence.indexFileExists(indexName);
  }

  _getIndexPath(indexName: string): string {
    return this.persistence.getIndexPath(indexName);
  }

  _getIndexMetadataPath(indexPath: string): string {
    return this.persistence.getIndexMetadataPath(indexPath);
  }

  _writeIndexMetadata(indexPath: string): void {
    this.persistence.writeIndexMetadata(indexPath);
  }

  scheduleIndexSave(indexName: string): void {
    this.persistence.scheduleIndexSave(indexName);
  }

  override async add(indexName: string, id: number, vector: VectorLike): Promise<void> {
    assertVectorDimension(vector, this.dimension, "Vexus vector");
    assertFiniteVector(vector, "Vexus vector");
    const normalized = toFloat32Array(vector);
    this.getOrCreateIndex(indexName).add(id, normalized);
  }

  override async addBatch(
    indexName: string,
    ids: readonly number[],
    vectors: readonly VectorLike[] | VectorLike,
  ): Promise<void> {
    const index = this.getOrCreateIndex(indexName);
    if (typeof index.addBatch === "function") {
      index.addBatch([...ids], flattenBatch(vectors, ids.length, this.dimension));
      return;
    }

    const vectorList = vectors as readonly VectorLike[];
    for (let i = 0; i < ids.length; i++) {
      const inputVector = vectorList[i];
      if (!inputVector) continue;
      const normalized = toValidatedFloat32Array(
        inputVector,
        this.dimension,
        `Vexus vector ${i}`,
      );
      index.add(at(ids, i, "vector ids"), normalized);
    }
  }

  override async search(
    indexName: string,
    queryVector: VectorLike,
    k: number,
  ): Promise<VectorHit[]> {
    assertVectorDimension(queryVector, this.dimension, "Vexus query vector");
    assertFiniteVector(queryVector, "Vexus query vector");
    if (!Number.isSafeInteger(k) || k < 0) {
      throw new RangeError("Vexus search k must be a non-negative safe integer.");
    }

    const index = this.indices.get(indexName);
    if (!index) return [];
    return parseNativeSearchResults(index.search(toFloat32Array(queryVector), k));
  }

  override async remove(indexName: string, id: number): Promise<void> {
    this.indices.get(indexName)?.remove(id);
  }

  async replaceIndex(
    indexName: string,
    entries: readonly VectorIndexEntry[],
  ): Promise<void> {
    const index = createVexusIndex(
      this.dimension,
      Math.max(this.defaultCapacity, entries.length, 1),
    );
    for (const entry of entries) {
      const vector = toValidatedFloat32Array(
        entry.vector,
        this.dimension,
        `Vexus index entry ${entry.id}`,
      );
      index.add(entry.id, vector);
    }
    this.persistence.replaceIndex(indexName, index);
  }

  loadIndex(indexName: string, filePath: string): Promise<VexusIndex> {
    return this.persistence.loadIndex(indexName, filePath);
  }

  saveIndex(indexName: string, filePath?: string): Promise<void> {
    return this.persistence.saveIndex(indexName, filePath);
  }

  restorePersistedIndexes(indexNames: readonly string[]): Promise<boolean> {
    return this.persistence.restorePersistedIndexes(indexNames);
  }

  async getIndexStats(indexName: string): Promise<VectorStoreStats> {
    const index = this.indices.get(indexName);
    if (!index) return { size: 0, capacity: 0, dimension: this.dimension };

    const stats = index.stats();
    return {
      size: numericStat(stats.totalVectors, 0),
      capacity: numericStat(stats.capacity, 0),
      dimension: numericStat(stats.dimensions, this.dimension),
    };
  }

  resetDerivedState(): void {
    this.persistence.resetDerivedState();
  }

  flushPendingSaves(): void {
    this.persistence.flushPendingSaves();
  }
}

function toFloat32Array(vector: VectorLike): Float32Array {
  return vector instanceof Float32Array ? vector : new Float32Array(vector);
}

function toValidatedFloat32Array(
  vector: VectorLike,
  dimension: number,
  label: string,
): Float32Array {
  assertVectorDimension(vector, dimension, label);
  assertFiniteVector(vector, label);
  return toFloat32Array(vector);
}

function flattenBatch(
  vectors: readonly VectorLike[] | VectorLike,
  count: number,
  dimension: number,
): Float32Array {
  if (vectors instanceof Float32Array) {
    assertVectorDimension(vectors, count * dimension, "Vexus batch vectors");
    assertFiniteVector(vectors, "Vexus batch vectors");
    return vectors;
  }

  const flat = new Float32Array(count * dimension);
  const vectorList = vectors as readonly VectorLike[];
  for (let i = 0; i < count; i++) {
    const vector = toValidatedFloat32Array(
      at(vectorList, i, "vector list"),
      dimension,
      `Vexus vector ${i}`,
    );
    flat.set(vector, i * dimension);
  }
  return flat;
}

function numericStat(value: number | bigint | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number(value) || fallback;
}

export default VexusVectorStore;
