'use strict';

import path = require('path');
import fs = require('fs');
import crypto = require('crypto');
import VectorStore = require('../interfaces/vector-store');

import { VexusIndex } from '../native/vexus-lite';
import type { VectorHit, VectorLike, VectorStoreStats } from '../types';

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
    this.dimension = config.dimension || 3072;
    this.storePath = config.storePath || '.';
    this.defaultCapacity = config.tagIndexCapacity || 50000;
    this.indexSaveDelay = config.indexSaveDelay || 5000;
    this.tagIndexSaveDelay = config.tagIndexSaveDelay || 10000;
    this.persistTagIndex = config.persistTagIndex || false;
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
    const cap = capacity || this.defaultCapacity;
    let index = null;
    if (this.indexLoadEnabled && this._indexFileExists(indexName)) {
      try {
        index = VexusIndex.load(
          this._getIndexPath(indexName),
          null,
          this.dimension,
          cap
        );
      } catch (e) {
        console.error(
          `[VexusVectorStore] Failed to load persisted index "${indexName}", ` +
          `creating fresh one instead: ${e instanceof Error ? e.message : String(e)}`
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
    const safeName = crypto
      .createHash('md5')
      .update(indexName)
      .digest('hex');
    return path.join(this.storePath, `index_${safeName}.usearch`);
  }

  /**
   * Schedule a delayed save for an index.  Subsequent calls within
   * the delay window are coalesced into a single save.
   * @param {string} indexName
   */
  scheduleIndexSave(indexName: string): void {
    if (this.saveTimers.has(indexName)) return;
    const delay = indexName === 'global_tags'
      ? this.tagIndexSaveDelay
      : this.indexSaveDelay;
    const timer = setTimeout(() => {
      this.saveTimers.delete(indexName);
      const index = this.indices.get(indexName);
      if (!index || typeof index.save !== 'function') return;
      try {
        const filePath = this._getIndexPath(indexName);
        index.save(filePath);
      } catch (e) {
        console.error(
          `[VexusVectorStore] Scheduled save failed for "${indexName}": ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }, delay);
    this.saveTimers.set(indexName, timer);
  }

  // ── VectorStore interface ────────────────────────────────────

  async add(indexName: string, id: number, vector: VectorLike): Promise<void> {
    const index = this.getOrCreateIndex(indexName);
    const vec = vector instanceof Float32Array
      ? vector
      : new Float32Array(vector);
    index.add(id, vec);
  }

  async addBatch(
    indexName: string,
    ids: readonly number[],
    vectors: readonly VectorLike[] | VectorLike,
  ): Promise<void> {
    const index = this.getOrCreateIndex(indexName);

    if (typeof index.addBatch === 'function') {
      // Native addBatch expects a single flat Float32Array (n * dim)
      let flatVectors;
      if (vectors instanceof Float32Array) {
        flatVectors = vectors;
      } else {
        flatVectors = new Float32Array(ids.length * this.dimension);
        const vectorList = vectors as readonly VectorLike[];
        for (let i = 0; i < ids.length; i++) {
          const v = vectorList[i] instanceof Float32Array
            ? vectorList[i]
            : new Float32Array(vectorList[i]);
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
        const v = inputVector instanceof Float32Array
          ? inputVector
          : new Float32Array(inputVector);
        index.add(ids[i], v);
      }
    }
  }

  async search(indexName: string, queryVector: VectorLike, k: number): Promise<VectorHit[]> {
    const index = this.indices.get(indexName);
    if (!index) return [];

    const query = queryVector instanceof Float32Array
      ? queryVector
      : new Float32Array(queryVector);

    const results = index.search(query, k);

    // Convert BigInt IDs / scores to Number (N-API may return BigInt)
    return results.map((r): VectorHit => ({
      id: typeof r.id === 'bigint' ? Number(r.id) : r.id,
      score: typeof r.score === 'bigint' ? Number(r.score) : r.score
    }));
  }

  async remove(indexName: string, id: number): Promise<void> {
    const index = this.indices.get(indexName);
    if (!index) return;
    index.remove(id);
  }

  async loadIndex(indexName: string, filePath: string): Promise<VexusIndex> {
    const resolvedPath = filePath || this._getIndexPath(indexName);
    const index = VexusIndex.load(
      resolvedPath,
      null,
      this.dimension,
      this.defaultCapacity
    );
    this.indices.set(indexName, index);
    return index;
  }

  async saveIndex(indexName: string, filePath?: string): Promise<void> {
    const index = this.indices.get(indexName);
    if (!index) return;
    const resolvedPath = filePath || this._getIndexPath(indexName);
    index.save(resolvedPath);
  }

  async getIndexStats(indexName: string): Promise<VectorStoreStats> {
    const index = this.indices.get(indexName);
    if (!index) {
      return { size: 0, capacity: 0, dimension: this.dimension };
    }
    const stats = index.stats();
    return {
      size: typeof stats.totalVectors === 'bigint'
        ? Number(stats.totalVectors)
        : (stats.totalVectors || 0),
      capacity: typeof stats.capacity === 'bigint'
        ? Number(stats.capacity)
        : (stats.capacity || 0),
      dimension: typeof stats.dimensions === 'bigint'
        ? Number(stats.dimensions)
        : (stats.dimensions || this.dimension)
    };
  }

  // ── Cleanup ──────────────────────────────────────────────────

  /**
   * Flush all pending saves and clear timers.
   */
  flushPendingSaves(): void {
    const toFlush = new Set([...this.saveTimers.keys(), ...this.indices.keys()]);
    for (const name of toFlush) {
      const timer = this.saveTimers.get(name);
      if (timer) {
        clearTimeout(timer);
        this.saveTimers.delete(name);
      }
      const index = this.indices.get(name);
      if (index && typeof index.save === 'function') {
        try {
          index.save(this._getIndexPath(name));
        } catch (e) {
          console.error(
            `[VexusVectorStore] Flush save failed for "${name}": ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    }
  }
}

export = VexusVectorStore;
