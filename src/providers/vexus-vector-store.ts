"use strict";

import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import VectorStore from "../interfaces/vector-store.js";

import { getVexusIndex } from "../native/vexus-lite.js";
import type { VexusIndex } from "../native/vexus-lite.js";
import type {
  VectorHit,
  VectorIndexEntry,
  VectorLike,
  VectorStoreStats,
} from "../types.js";
import {
  at,
  assertDimension,
  assertFiniteVector,
  assertVectorDimension,
} from "../utils/numerical.js";

interface NativeSearchResult {
  id: number;
  score: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function parseNativeSearchResults(value: unknown): NativeSearchResult[] {
  if (!Array.isArray(value)) return [];
  const results: NativeSearchResult[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const rawId = item.id;
    const rawScore = item.score;
    if (
      (typeof rawId !== "number" && typeof rawId !== "bigint") ||
      (typeof rawScore !== "number" && typeof rawScore !== "bigint")
    ) {
      continue;
    }
    const id = Number(rawId);
    const score = Number(rawScore);
    if (Number.isSafeInteger(id) && Number.isFinite(score)) results.push({ id, score });
  }
  return results;
}

interface VexusStoreConfig {
  dimension?: number;
  storePath?: string;
  tagIndexCapacity?: number;
  indexSaveDelay?: number;
  tagIndexSaveDelay?: number;
  persistTagIndex?: boolean;
  indexLoadEnabled?: boolean;
}

/**
 * Vector store backed by the Rust N-API VexusIndex (usearch).
 *
 * Manages named indices in an in-memory Map, with optional delayed
 * persistence to disk.  Ported from modules/knowledgeBase/indexRepository.js
 * with all SQLite recovery / coordinator logic stripped out.
 */
class VexusVectorStore extends VectorStore {
  dimension: number;
  storePath: string;
  defaultCapacity: number;
  indexSaveDelay: number;
  tagIndexSaveDelay: number;
  persistTagIndex: boolean;
  indexLoadEnabled: boolean;
  indices: Map<string, VexusIndex>;
  saveTimers: Map<string, NodeJS.Timeout>;
  /**
   * @param {object} config
   * @param {number} config.dimension          - Vector dimension
   * @param {string} [config.storePath]        - Directory for persisted indices
   * @param {number} [config.tagIndexCapacity] - Default capacity for new indices (default 50000)
   * @param {number} [config.indexSaveDelay]   - Delay in ms for scheduleIndexSave (default 5000)
   * @param {number} [config.tagIndexSaveDelay]- Delay in ms for tag index saves (default 10000)
   * @param {boolean} [config.persistTagIndex] - Whether to persist the tag index
   */
  constructor(config: VexusStoreConfig = {}) {
    super();
    this.dimension = config.dimension ?? 3072;
    assertDimension(this.dimension, "Vexus vector dimension");
    this.storePath = config.storePath ?? ".";
    this.defaultCapacity = config.tagIndexCapacity ?? 50000;
    this.indexSaveDelay = config.indexSaveDelay ?? 5000;
    this.tagIndexSaveDelay = config.tagIndexSaveDelay ?? 10000;
    this.persistTagIndex = config.persistTagIndex ?? false;
    this.indexLoadEnabled = config.indexLoadEnabled !== false;

    /** @type {Map<string, VexusIndex>} */
    this.indices = new Map();
    /** @type {Map<string, NodeJS.Timeout>} */
    this.saveTimers = new Map();
  }

  // ── Index lifecycle ──────────────────────────────────────────

  /**
   * Get an existing index or create a new one lazily.
   * @param {string} indexName
   * @param {number} [capacity] - Defaults to this.defaultCapacity
   * @returns {VexusIndex}
   */
  getOrCreateIndex(indexName: string, capacity?: number): VexusIndex {
    const existing = this.indices.get(indexName);
    if (existing) {
      return existing;
    }
    const VexusIndex = getVexusIndex();
    const cap = capacity ?? this.defaultCapacity;
    let index = null;
    if (
      this.indexLoadEnabled &&
      (this.persistTagIndex || indexName !== "global_tags") &&
      this._indexFileExists(indexName)
    ) {
      try {
        index = VexusIndex.load(
          this._getIndexPath(indexName),
          null,
          this.dimension,
          cap,
        );
      } catch (e) {
        console.error(
          `[VexusVectorStore] Failed to load persisted index "${indexName}", ` +
            `creating fresh one instead: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (!index) {
      index = new VexusIndex(this.dimension, cap);
    }
    this.indices.set(indexName, index);
    return index;
  }

  /**
   * Whether a persisted index file exists on disk for the given name.
   * @param {string} indexName
   * @returns {boolean}
   * @private
   */
  _indexFileExists(indexName: string): boolean {
    try {
      return fs.existsSync(this._getIndexPath(indexName));
    } catch (_) {
      return false;
    }
  }

  /**
   * Compute the on-disk path for a named index.
   * @param {string} indexName
   * @returns {string}
   * @private
   */
  _getIndexPath(indexName: string): string {
    const safeName = crypto.createHash("md5").update(indexName).digest("hex");
    return path.join(this.storePath, `index_${safeName}.usearch`);
  }

  _getIndexMetadataPath(indexPath: string): string {
    return `${indexPath}.meta.json`;
  }

  private _invalidatePersistedIndex(indexName: string): void {
    const indexPath = this._getIndexPath(indexName);
    for (const filePath of [indexPath, this._getIndexMetadataPath(indexPath)]) {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  _writeIndexMetadata(indexPath: string): void {
    fs.writeFileSync(
      this._getIndexMetadataPath(indexPath),
      JSON.stringify({ dimension: this.dimension }),
      "utf8",
    );
  }

  /**
   * Schedule a delayed save for an index.  Subsequent calls within
   * the delay window are coalesced into a single save.
   * @param {string} indexName
   */
  scheduleIndexSave(indexName: string): void {
    if (!this.persistTagIndex && indexName === "global_tags") return;
    if (this.saveTimers.has(indexName)) return;
    const delay =
      indexName === "global_tags" ? this.tagIndexSaveDelay : this.indexSaveDelay;
    const timer = setTimeout(() => {
      this.saveTimers.delete(indexName);
      const index = this.indices.get(indexName);
      if (!index || typeof index.save !== "function") return;
      try {
        const filePath = this._getIndexPath(indexName);
        fs.mkdirSync(this.storePath, { recursive: true });
        index.save(filePath);
        this._writeIndexMetadata(filePath);
      } catch (e) {
        console.error(
          `[VexusVectorStore] Scheduled save failed for "${indexName}": ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }, delay);
    this.saveTimers.set(indexName, timer);
  }

  // ── VectorStore interface ────────────────────────────────────

  override async add(indexName: string, id: number, vector: VectorLike): Promise<void> {
    assertVectorDimension(vector, this.dimension, "Vexus vector");
    assertFiniteVector(vector, "Vexus vector");
    const index = this.getOrCreateIndex(indexName);
    const vec = vector instanceof Float32Array ? vector : new Float32Array(vector);
    index.add(id, vec);
  }

  override async addBatch(
    indexName: string,
    ids: readonly number[],
    vectors: readonly VectorLike[] | VectorLike,
  ): Promise<void> {
    const index = this.getOrCreateIndex(indexName);

    if (typeof index.addBatch === "function") {
      // Native addBatch expects a single flat Float32Array (n * dim)
      let flatVectors;
      if (vectors instanceof Float32Array) {
        flatVectors = vectors;
        assertVectorDimension(
          flatVectors,
          ids.length * this.dimension,
          "Vexus batch vectors",
        );
        assertFiniteVector(flatVectors, "Vexus batch vectors");
      } else {
        flatVectors = new Float32Array(ids.length * this.dimension);
        const vectorList = vectors as readonly VectorLike[];
        for (let i = 0; i < ids.length; i++) {
          const inputVector = at(vectorList, i, "vector list");
          const v =
            inputVector instanceof Float32Array
              ? inputVector
              : new Float32Array(inputVector);
          assertVectorDimension(v, this.dimension, `Vexus vector ${i}`);
          assertFiniteVector(v, `Vexus vector ${i}`);
          flatVectors.set(v, i * this.dimension);
        }
      }
      index.addBatch([...ids], flatVectors);
    } else {
      // Fallback: individual adds
      const vectorList = vectors as readonly VectorLike[];
      for (let i = 0; i < ids.length; i++) {
        const inputVector = vectorList[i];
        if (!inputVector) continue;
        const v =
          inputVector instanceof Float32Array
            ? inputVector
            : new Float32Array(inputVector);
        index.add(at(ids, i, "vector ids"), v);
      }
    }
  }

  override async search(
    indexName: string,
    queryVector: VectorLike,
    k: number,
  ): Promise<VectorHit[]> {
    assertVectorDimension(queryVector, this.dimension, "Vexus query vector");
    assertFiniteVector(queryVector, "Vexus query vector");
    if (!Number.isSafeInteger(k) || k < 0)
      throw new RangeError("Vexus search k must be a non-negative safe integer.");
    const index = this.indices.get(indexName);
    if (!index) return [];

    const query =
      queryVector instanceof Float32Array ? queryVector : new Float32Array(queryVector);

    const results: unknown = index.search(query, k);

    // Convert BigInt IDs / scores to Number (N-API may return BigInt)
    return parseNativeSearchResults(results);
  }

  override async remove(indexName: string, id: number): Promise<void> {
    const index = this.indices.get(indexName);
    if (!index) return;
    index.remove(id);
  }

  async replaceIndex(
    indexName: string,
    entries: readonly VectorIndexEntry[],
  ): Promise<void> {
    const pendingTimer = this.saveTimers.get(indexName);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.saveTimers.delete(indexName);
    }
    const capacity = Math.max(this.defaultCapacity, entries.length, 1);
    const VexusIndex = getVexusIndex();
    const index = new VexusIndex(this.dimension, capacity);
    for (const entry of entries) {
      assertVectorDimension(
        entry.vector,
        this.dimension,
        `Vexus index entry ${entry.id}`,
      );
      assertFiniteVector(entry.vector, `Vexus index entry ${entry.id}`);
      const vector =
        entry.vector instanceof Float32Array
          ? entry.vector
          : new Float32Array(entry.vector);
      index.add(entry.id, vector);
    }
    this.indices.set(indexName, index);
  }

  async loadIndex(indexName: string, filePath: string): Promise<VexusIndex> {
    const resolvedPath = filePath || this._getIndexPath(indexName);
    const VexusIndex = getVexusIndex();
    const index = VexusIndex.load(
      resolvedPath,
      null,
      this.dimension,
      this.defaultCapacity,
    );
    this.indices.set(indexName, index);
    return index;
  }

  async saveIndex(indexName: string, filePath?: string): Promise<void> {
    if (!this.persistTagIndex && indexName === "global_tags") return;
    const index = this.indices.get(indexName);
    if (!index) return;
    const resolvedPath = filePath || this._getIndexPath(indexName);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    index.save(resolvedPath);
    this._writeIndexMetadata(resolvedPath);
  }

  async restorePersistedIndexes(indexNames: readonly string[]): Promise<boolean> {
    const VexusIndex = getVexusIndex();
    const requestedNames = [...indexNames];
    const nonPersistedTagRequested =
      !this.persistTagIndex && requestedNames.includes("global_tags");
    if (!this.persistTagIndex) this._invalidatePersistedIndex("global_tags");
    if (!this.indexLoadEnabled) return false;
    const namesToLoad = nonPersistedTagRequested
      ? requestedNames.filter((name) => name !== "global_tags")
      : requestedNames;
    const loadedIndexes = new Map<string, VexusIndex>();
    for (const indexName of namesToLoad) {
      const indexPath = this._getIndexPath(indexName);
      if (!this._indexFileExists(indexName)) return false;
      try {
        const metadataPath = this._getIndexMetadataPath(indexPath);
        if (fs.existsSync(metadataPath)) {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
            dimension?: unknown;
          };
          if (Number(metadata.dimension) !== this.dimension) return false;
        }
        const index = VexusIndex.load(
          indexPath,
          null,
          this.dimension,
          this.defaultCapacity,
        );
        const stats = index.stats();
        const dimensions =
          typeof stats.dimensions === "bigint"
            ? Number(stats.dimensions)
            : Number(stats.dimensions);
        if (Number.isFinite(dimensions) && dimensions !== this.dimension) return false;
        loadedIndexes.set(indexName, index);
      } catch (_) {
        return false;
      }
    }
    for (const [indexName, index] of loadedIndexes) {
      this.indices.set(indexName, index);
    }
    return true;
  }

  async getIndexStats(indexName: string): Promise<VectorStoreStats> {
    const index = this.indices.get(indexName);
    if (!index) {
      return { size: 0, capacity: 0, dimension: this.dimension };
    }
    const stats = index.stats();
    return {
      size:
        typeof stats.totalVectors === "bigint"
          ? Number(stats.totalVectors)
          : stats.totalVectors || 0,
      capacity:
        typeof stats.capacity === "bigint"
          ? Number(stats.capacity)
          : stats.capacity || 0,
      dimension:
        typeof stats.dimensions === "bigint"
          ? Number(stats.dimensions)
          : stats.dimensions || this.dimension,
    };
  }

  // ── Cleanup ──────────────────────────────────────────────────

  /**
   * Clear all derived vector state before an authority rebuild.
   * Only files created by this store's stable index naming convention are
   * eligible for deletion.
   */
  resetDerivedState(): void {
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    this.indices.clear();

    if (!fs.existsSync(this.storePath)) return;
    for (const entry of fs.readdirSync(this.storePath, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/^index_[0-9a-f]{32}\.usearch(?:\.meta\.json)?$/.test(entry.name)) {
        continue;
      }
      fs.unlinkSync(path.join(this.storePath, entry.name));
    }
  }

  /**
   * Flush all pending saves and clear timers.
   */
  flushPendingSaves(): void {
    for (const [name, timer] of this.saveTimers) {
      if (!this.persistTagIndex && name === "global_tags") {
        clearTimeout(timer);
        this.saveTimers.delete(name);
      }
    }
    const toFlush = new Set(
      [...this.saveTimers.keys(), ...this.indices.keys()].filter(
        (name) => this.persistTagIndex || name !== "global_tags",
      ),
    );
    let firstError: unknown = null;
    for (const name of toFlush) {
      const timer = this.saveTimers.get(name);
      if (timer) {
        clearTimeout(timer);
        this.saveTimers.delete(name);
      }
      const index = this.indices.get(name);
      if (index && typeof index.save === "function") {
        try {
          fs.mkdirSync(this.storePath, { recursive: true });
          const indexPath = this._getIndexPath(name);
          index.save(indexPath);
          this._writeIndexMetadata(indexPath);
        } catch (e) {
          firstError ??= e;
        }
      }
    }
    if (firstError) throw firstError;
  }
}

export default VexusVectorStore;
