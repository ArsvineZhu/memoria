'use strict';

const path = require('path');

const ResultDeduplicator =
  require('../algorithms/result-deduplicator');
const { decodeVectorBlob } = require('../utils/vector-codec');
const { EPA } = require('../algorithms/epa');

/**
 * KnowledgeBaseAdapter — drop-in compatibility surface for
 * KnowledgeBaseManager consumers.
 *
 * Call sites found by grepping the repository (server.js, Plugin/,
 * modules/, routes/):
 *
 *   server.js:1524                        await kbm.initialize()
 *   server.js:1832                        await kbm.shutdown()
 *   routes/admin/system.js:227            kbm.getMemoryProfile()
 *   routes/admin/rag.js                   kbm.getHealthStatus()
 *   routes/admin/dream.js:92/108          kbm.removeDocument(path)        [guarded]
 *   routes/admin/dailyNotes.js:18         kbm.runExternalFileMutation(owner, fn, opts)
 *   Plugin/DailyNote/*, DailyNoteManager  kbm.runExternalFileMutation...   [guarded]
 *   Plugin/AgentDream/*                   kbm.initialized, kbm.search(diary, vec, k, boost),
 *                                         kbm.db.prepare(...), kbm.config
 *   modules/vcpLoop/toolExecutor.js:138   kbm.db.prepare(...), kbm.search(diary, vec, n),
 *                                         kbm.config?.rootPath
 *   Plugin/RAGDiaryPlugin                 kbm.search(diaryNames, vec, k, ...),
 *                                         kbm.deduplicateResults(...),
 *                                         kbm.getEPAAnalysis(vec),
 *                                         kbm.applyTagBoostAsync(...),
 *                                         kbm.rerankWithRiverMemoAsync(...),
 *                                         kbm.getDiaryDateIndex(name),
 *                                         kbm.getDiaryNameVector(name),
 *                                         kbm.getVectorByText(name, text),
 *                                         kbm.getVectorByChunkId(id),
 *                                         kbm.getChunksByFilePaths(paths)
 *   Plugin/LightMemo                      kbm.db, kbm.config.dimension,
 *                                         kbm.applyTagBoostAsync(...),
 *                                         kbm.rerankWithTagMemoAsync(...),
 *                                         kbm.rerankWithRiverMemoAsync(...)
 *
 * The TagMemoEngine-only surface (requestRustWriteLease, checkpoint...,
 * getTagMemoArtifactSnapshot, Tag consistency previews, ...) is NOT
 * provided: every call site guards with `typeof x === 'function'` and
 * falls back gracefully when the method is absent. Tag boost / geodesic
 * rerank return honest passthrough envelopes (no boost signal, unchanged
 * candidate order) so callers keep their documented fall backs.
 *
 * The legacy search(diaryName, vec, k, tagBoost) vector path is a plain
 * per-index KNN + hydration pass; TagMemo rerank / geodesic rerank are
 * outside the standalone library's scope. Text queries (`search(str)`)
 * delegate to the MemoryEngine search pipeline.
 */
class KnowledgeBaseAdapter {
  /**
   * @param {object} options
   * @param {import('../engine').MemoryEngine} options.engine
   */
  constructor({ engine } = {}) {
    if (!engine) {
      throw new TypeError('KnowledgeBaseAdapter requires an engine');
    }
    this.name = 'knowledgeBaseAdapter';
    this.engine = engine;

    // ── Call-site passthroughs ──────────────────────────────────────
    this.flush = (files) => {
      this._invalidateCaches();
      return engine.flush(files);
    };
    this.flushBatch = (files) => {
      this._invalidateCaches();
      return engine.flushBatch(files);
    };
    this.handleDelete = (input) => {
      this._invalidateCaches();
      return engine.handleDelete(input);
    };
    this.deleteFile = (filePath) => {
      this._invalidateCaches();
      return engine.deleteFile(filePath);
    };
    this.getStats = () => engine.getStats();
    this.close = () => engine.close();

    // Serialization tail for runExternalFileMutation.
    this._mutationTail = Promise.resolve();
    // EPA basis cache (invalidated on every ingest/delete).
    this._epaCache = null;
  }

  /** KBM call sites read `kbm.initialized` before initialize(). */
  get initialized() {
    return !!(this.engine && this.engine.initialized);
  }

  /** toolExecutor surface: raw SQLite handle (guard: `if (!kbm.db)`). */
  get db() {
    const store = this.engine && this.engine.metadataStore;
    return (store && store.db) || null;
  }

  /** toolExecutor / DreamWaveEngine surface: merged engine config. */
  get config() {
    return (this.engine && this.engine.config) || {};
  }

  async initialize() {
    return this.engine.initialize();
  }

  /** server.js shutdown hook. */
  async shutdown() {
    return this.engine.close();
  }

  /**
   * DailyNote/DailyNoteManager surface: serialize a long-running file
   * mutation behind the watcher batch, mirroring databaseCoordinator's
   * external mutation gate (a simple FIFO mutex in the standalone lib).
   * @param {string} owner
   * @param {Function} operation - () => Promise<any>
   * @param {object} [options]
   * @returns {Promise<any>} operation result
   */
  runExternalFileMutation(owner, operation, options = {}) {
    if (typeof operation !== 'function') {
      return Promise.reject(new TypeError('runExternalFileMutation requires an operation function'));
    }
    const run = this._mutationTail.then(async () => {
      this._mutationOwner = owner;
      try {
        return await operation();
      } finally {
        this._mutationOwner = null;
      }
    });
    // The tail swallows failures so one mutation never wedges the queue.
    this._mutationTail = run.catch(() => {});
    return run;
  }

  /**
   * system/raven monitor: `{ available, estimatedBytes, ... }`.
   * Synchronous (routes/admin/system.js does not await it). Estimate:
   * resident vectors × dimension × 4 bytes (+ SQLite page baseline),
   * mirroring buildMemoryProfile's diagnostic estimate.
   */
  getMemoryProfile() {
    const engine = this.engine;
    if (!engine || !engine.initialized) {
      return { available: false, estimatedBytes: 0 };
    }
    let vectors = 0;
    let indices = 0;
    const vectorStore = engine.vectorStore;
    if (vectorStore && vectorStore.indices instanceof Map) {
      for (const index of vectorStore.indices.values()) {
        indices += 1;
        if (!index || typeof index.stats !== 'function') continue;
        try {
          const stats = index.stats();
          vectors += Number(stats && stats.totalVectors) || 0;
        } catch (e) {
          // A single index must not break the whole profile.
        }
      }
    }
    const dimension = Number(engine.config && engine.config.dimension) || 0;
    return {
      available: true,
      estimatedBytes: vectors * dimension * 4,
      vectors,
      indices,
      dimension
    };
  }

  /**
   * routes/admin/rag.js reads getHealthStatus() synchronously.
   * @returns {{status:string, healthy:boolean, issues:string[]}}
   */
  getHealthStatus() {
    const store = this.engine && this.engine.metadataStore;
    if (!store) {
      return { status: 'unavailable', healthy: false, issues: [] };
    }
    const issues = [];
    try {
      if (store.db && typeof store.db.prepare === 'function') {
        store.db.prepare('SELECT 1').get();
      }
    } catch (e) {
      issues.push((e && e.message) || String(e));
    }
    return {
      status: issues.length === 0 ? 'healthy' : 'degraded',
      healthy: issues.length === 0,
      issues
    };
  }

  /**
   * KnowledgeBaseManager.search(...args) compatibility.
   *
   * Legacy dispatch rules (mirror SearchService.search):
   *   search(diaryName|string[], queryVec, k, tagBoost,...) → raw index
   *     KNN on the named diaries, hydrated to chunk rows.
   *   search(queryString)                                  → engine text
   *     pipeline (formatted results envelope).
   *   search(vector, k, ...)                → all-indices KNN hydration.
   */
  async search(...args) {
    const [arg1, arg2] = args;
    const isDiaryNameArray = Array.isArray(arg1) && arg1.every(name => typeof name === 'string');
    if ((typeof arg1 === 'string' || isDiaryNameArray) && this._isVectorLike(arg2)) {
      return this._vectorSearch(
        isDiaryNameArray ? arg1 : [arg1],
        arg2,
        Number(args[2]) || 5,
        args[3] || 0
      );
    }
    if (this._isVectorLike(arg1)) {
      const names = await this._vectorIndexNames();
      return this._vectorSearch(names, arg1, Number(args[1]) || 5, args[2] || 0);
    }
    // Text search falls back to the engine pipeline.
    return this.engine.search(String(arg1 || ''), typeof arg2 === 'object' && arg2 !== null ? arg2 : {});
  }

  /**
   * Resolve the set of vector index names searchable for a legacy query.
   * @private
   */
  async _vectorIndexNames() {
    const engine = this.engine;
    if (engine.vectorStore && engine.vectorStore.indices instanceof Map && engine.vectorStore.indices.size > 0) {
      return [...engine.vectorStore.indices.keys()];
    }
    try {
      const names = await engine.metadataStore.getDistinctDiaryNames();
      return names && names.length ? names : ['Root'];
    } catch (e) {
      return ['Root'];
    }
  }

  _isVectorLike(value) {
    return Array.isArray(value)
      || value instanceof Float32Array
      || (ArrayBuffer.isView(value) && typeof value.length === 'number');
  }

  /**
   * KNN over the given diary indices, deduped by chunkId, hydrated
   * into the KnowledgeBaseManager result shape:
   *   { chunkId, text, score, sourceFile, fullPath, matchedTags,
   *     tagMatchCount, coreTagsMatched, boostFactor, tagMatchScore }
   * @param {string[]} indexNames
   * @param {Array|Float32Array} queryVector
   * @param {number} k
   * @param {number|string} tagBoost
   * @returns {Promise<Array<object>>}
   */
  async _vectorSearch(indexNames, queryVector, k, tagBoost) {
    const engine = this.engine;
    const vectorStore = engine.vectorStore;
    const store = engine.metadataStore;
    if (!vectorStore || typeof vectorStore.search !== 'function') return [];

    const query = queryVector instanceof Float32Array
      ? queryVector
      : new Float32Array(queryVector);

    const bestById = new Map();
    for (const indexName of indexNames) {
      let results = [];
      try {
        results = await vectorStore.search(indexName, query, Math.max(1, Math.round(k)));
      } catch (e) {
        continue;
      }
      for (const hit of results || []) {
        const chunkId = Number(hit && hit.id);
        if (!Number.isFinite(chunkId)) continue;
        const score = Number(hit && hit.score) || 0;
        const previous = bestById.get(chunkId);
        if (!previous || score > previous.score) {
          bestById.set(chunkId, { chunkId, score });
        }
      }
    }

    const hydrated = [];
    for (const { chunkId, score } of bestById.values()) {
      let chunk = null;
      try {
        chunk = await store.getChunkById(chunkId);
      } catch (e) {
        continue;
      }
      const row = chunk && chunk.fileId != null
        ? await store.getFileByChunkId(chunk.id)
        : null;
      const fullPath = row && row.path ? row.path : '';
      let tagNames = [];
      if (row) {
        try {
          const tags = await store.getFileTags(row.id);
          tagNames = Array.isArray(tags) ? tags.map(t => (t && t.name) || String(t)) : [];
        } catch (e) {
          tagNames = [];
        }
      }
      hydrated.push({
        chunkId,
        text: chunk ? chunk.content : '',
        score,
        sourceFile: fullPath ? path.basename(fullPath) : '',
        fullPath,
        matchedTags: tagNames,
        tagMatchCount: tagNames.length,
        coreTagsMatched: [],
        boostFactor: 0,
        tagMatchScore: 0
      });
    }

    hydrated.sort((a, b) => (b.score - a.score) || (a.chunkId - b.chunkId));
    return hydrated.slice(0, Math.max(1, Math.round(k)));
  }

  // ══════════════════════════════════════════════════════════════════
  // Extended RAG / plugin call-site surface (Phase 7 wiring)
  // ══════════════════════════════════════════════════════════════════

  /**
   * routes/admin/dream.js surface: remove a single indexed file.
   * @param {string} filePath
   * @returns {Promise<object>} engine delete envelope
   */
  removeDocument(filePath) {
    this._invalidateCaches();
    return this.engine.deleteFile(String(filePath || ''));
  }

  /**
   * Drop caches whose validity depends on the ingested corpus.
   * @private
   */
  _invalidateCaches() {
    this._epaCache = null;
  }

  /**
   * RAGDiaryPlugin surface: unified result deduplication (exact identity
   * + optional semantic suppression), mirroring KnowledgeBaseManager.
   * @param {Array<object>} candidates
   * @param {Float32Array|Array<number>|null} queryVector
   * @param {object} options - { semantic, semanticThreshold, maxResults, stage }
   * @returns {Promise<Array<object>>}
   */
  async deduplicateResults(candidates, queryVector = null, options = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) return [];
    const deduplicator = this._resultDeduplicator || this._createResultDeduplicator();
    this._resultDeduplicator = deduplicator;
    try {
      return await deduplicator.deduplicate(candidates, queryVector, options);
    } catch (error) {
      console.warn(
        `[KnowledgeBaseAdapter] deduplicateResults failed at stage=${options.stage || 'unknown'}; ` +
        `falling back to exact deduplication: ${error.message}`
      );
      try {
        return deduplicator.hardDeduplicate(candidates);
      } catch (fallbackError) {
        console.warn(
          `[KnowledgeBaseAdapter] Exact deduplication fallback also failed: ${fallbackError.message}`
        );
        return candidates;
      }
    }
  }

  /**
   * @private
   */
  _createResultDeduplicator() {
    const engine = this.engine;
    const store = engine && engine.metadataStore;
    return new ResultDeduplicator(
      (store && store.db) || null,
      {
        dimension: Number(engine && engine.config && engine.config.dimension) || 3072
      }
    );
  }

  /**
   * RAGDiaryPlugin surface: EPA semantic depth analysis for a query vector.
   * Builds (and caches) an EPA basis from the stored tag store; falls back
   * to the KnowledgeBaseManager neutral envelope when the basis is
   * unavailable. `resonance` is always a number.
   * @param {Array|Float32Array} vector
   * @returns {Promise<{logicDepth:number, resonance:number, entropy:number, dominantAxes:Array}>}
   */
  async getEPAAnalysis(vector) {
    const fallback = { logicDepth: 0.5, resonance: 0, entropy: 0.5, dominantAxes: [] };
    if (!vector || typeof vector.length !== 'number' || vector.length === 0) {
      return fallback;
    }

    const epa = await this._getEpa();
    if (!epa) return fallback;

    try {
      const projection = epa.project(vector);
      const resonanceInfo = epa.detectCrossDomainResonance(vector);
      const resonance = Number(
        resonanceInfo && resonanceInfo.resonance != null ? resonanceInfo.resonance : 0
      );
      return {
        logicDepth: Number(projection.logicDepth) || 0,
        resonance: Number.isFinite(resonance) ? resonance : 0,
        entropy: Number(projection.entropy) || 1,
        dominantAxes: projection.dominantAxes || []
      };
    } catch (e) {
      return fallback;
    }
  }

  /**
   * Resolve (or rebuild) the cached EPA basis. The basis is derived from
   * every stored tag vector and is invalidated on ingest/delete.
   * @returns {Promise<EPA|null>}
   * @private
   */
  async _getEpa() {
    const engine = this.engine;
    const store = engine && engine.metadataStore;
    const dimension = Number(engine && engine.config && engine.config.dimension) || 0;
    if (!store || typeof store.getAllTags !== 'function' || dimension <= 0) return null;

    if (
      this._epaCache
      && this._epaCache.dimension === dimension
      && this._epaCache.indexedAt === engine._lastIndexedAt
    ) {
      return this._epaCache.epa;
    }

    let tags = [];
    try {
      tags = await store.getAllTags();
    } catch (e) {
      return null;
    }
    const withVectors = (tags || []).filter(t => t && t.vector != null);
    if (withVectors.length < 2) return null;

    let basis;
    try {
      basis = EPA.computeBasis(withVectors, dimension, {
        clusterCount: Math.min(64, withVectors.length),
        maxBasisDim: Math.min(64, dimension)
      });
    } catch (e) {
      return null;
    }

    const epa = new EPA(basis, { dimension });
    this._epaCache = { epa, dimension, indexedAt: engine._lastIndexedAt };
    return epa;
  }

  /**
   * RAGDiaryPlugin / LightMemo surface: TagMemo V9 boosted-query envelope.
   *
   * The standalone library does not train TagMemo wave-field models, so
   * this is an honest passthrough: the query vector is returned unchanged
   * and `info.matchedTags` is empty. Callers treat that as "no boost" and
   * fall back to pure KNN / ghost tags.
   *
   * @param {Array|Float32Array} vector - query vector
   * @param {number} [tagBoost=0]
   * @param {Array<string>} [coreTags=[]]
   * @param {number} [coreBoostFactor=1.33]
   * @param {object} [options={}]
   * @returns {Promise<object>} boost envelope
   */
  async applyTagBoostAsync(vector, tagBoost = 0, coreTags = [], coreBoostFactor = 1.33, options = {}) {
    const source = vector instanceof Float32Array
      ? vector
      : new Float32Array(vector || []);
    return {
      vector: new Float32Array(source),
      info: {
        matchedTags: [],
        coreTagsMatched: [],
        boostFactor: 0,
        tagBoost: Number(tagBoost) || 0,
        tagMatchScore: 0
      },
      energyField: null,
      energyFieldProvenance: null,
      artifactBundle: null,
      preparedMemoObservation: null
    };
  }

  /**
   * LightMemo surface: geodetic rerank passthrough (returns the input
   * candidate order unchanged with a stable envelope).
   * @param {{text:string, vector:Float32Array}} query
   * @param {Array<object>} candidates
   * @param {object} [options]
   * @param {object} [meta]
   * @returns {Promise<{results:Array<object>, meta:null}>}
   */
  async rerankWithTagMemoAsync(query, candidates, options = {}, meta = {}) {
    return { results: Array.isArray(candidates) ? candidates : [], meta: null };
  }

  /**
   * RAGDiaryPlugin / LightMemo surface: RiverMemo rerank passthrough
   * (unchanged candidate order, stable envelope).
   * @param {object} query - { text, vector }
   * @param {Array<object>} candidates
   * @param {object} [options]
   * @returns {Promise<{results:Array<object>, meta:null}>}
   */
  async rerankWithRiverMemoAsync(query, candidates, options = {}) {
    return { results: Array.isArray(candidates) ? candidates : [], meta: null };
  }

  /**
   * RAGDiaryPlugin surface: diary date index (synchronous, KBM contract).
   * Mirrors diaryMetadataCache.getDateIndex: entries expose
   * `{ relativePath, date (ISO string), diaryDate (Date) }`, newest first.
   * @param {string} diaryName
   * @returns {Array<{relativePath:string, date:string, diaryDate:Date|null}>}
   */
  getDiaryDateIndex(diaryName) {
    const db = this.db;
    if (!db || typeof db.prepare !== 'function' || !diaryName) return [];

    let rows = [];
    try {
      rows = db.prepare(
        'SELECT path, updated_at, mtime FROM files WHERE diary_name = ?'
      ).all(String(diaryName));
    } catch (e) {
      return [];
    }

    return rows
      .map(row => {
        const time = Number(row.updated_at) || Number(row.mtime) || 0;
        const date = time > 0 ? new Date(time * 1000) : null;
        return {
          relativePath: String(row.path || ''),
          date: date ? date.toISOString() : null,
          diaryDate: date
        };
      })
      .filter(meta => meta.relativePath && meta.date)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  /**
   * Embed a diary name for diary-vs-query similarity.
   * @param {string} diaryName
   * @returns {Promise<Float32Array|null>}
   */
  async getDiaryNameVector(diaryName) {
    return this._embedText(String(diaryName || ''));
  }

  /**
   * Embed arbitrary text (RAGDiaryPlugin / MetaThinkingManager surface).
   * @param {string|null} diaryName - unused (kept for KBM signature parity)
   * @param {string} text
   * @returns {Promise<Float32Array|null>}
   */
  async getVectorByText(diaryName, text) {
    return this._embedText(String(text || ''));
  }

  /**
   * Float32Array-normalized single-text embedding through the engine
   * provider. Returns null when the provider is missing or the call fails.
   * @param {string} text
   * @returns {Promise<Float32Array|null>}
   * @private
   */
  async _embedText(text) {
    if (!text.trim()) return null;
    const provider = this.engine && this.engine.embeddingProvider;
    if (!provider || typeof provider.embedBatch !== 'function') return null;
    try {
      const vectors = await provider.embedBatch([text]);
      const vector = vectors && vectors[0];
      if (vector == null) return null;
      return vector instanceof Float32Array
        ? vector
        : new Float32Array(vector);
    } catch (e) {
      return null;
    }
  }

  /**
   * RAGDiaryPlugin surface: read a chunk's stored vector by id.
   * @param {number|string} chunkId
   * @returns {Promise<Float32Array|null>}
   */
  async getVectorByChunkId(chunkId) {
    const db = this.db;
    if (!db || typeof db.prepare !== 'function') return null;
    const id = Number(chunkId);
    if (!Number.isFinite(id) || id <= 0) return null;
    try {
      const row = db.prepare('SELECT vector FROM chunks WHERE id = ?').get(id);
      if (!row || row.vector == null) return null;
      return this._decodeChunkVector(row.vector);
    } catch (e) {
      return null;
    }
  }

  /**
   * Decode a stored vector BLOB at the engine dimension.
   * @param {Buffer|Float32Array} blob
   * @returns {Float32Array|null}
   * @private
   */
  _decodeChunkVector(blob) {
    const dimension = Number(
      this.engine && this.engine.config && this.engine.config.dimension
    ) || 0;
    if (dimension <= 0) return null;
    return decodeVectorBlob(blob, dimension, 'chunk', { logPrefix: 'KnowledgeBaseAdapter' });
  }

  /**
   * RAGDiaryPlugin surface: hydrated chunk rows for a set of file paths.
   * Each row carries `chunkId`, `text`, `fullPath`, `sourceFile`,
   * `fileId`, `diaryName` and the decoded `vector` (Float32Array|null).
   * @param {Array<string>} filePaths
   * @returns {Promise<Array<object>>}
   */
  async getChunksByFilePaths(filePaths) {
    const db = this.db;
    if (!db || typeof db.prepare !== 'function' || !Array.isArray(filePaths)) {
      return [];
    }
    const unique = [...new Set(filePaths.filter(Boolean))];
    if (unique.length === 0) return [];

    const rows = [];
    for (let i = 0; i < unique.length; i += 500) {
      const batch = unique.slice(i, i + 500);
      const placeholders = batch.map(() => '?').join(',');
      try {
        rows.push(...db.prepare(`
          SELECT c.id AS chunk_id, c.chunk_index, c.content, c.vector,
                 f.id AS file_id, f.path AS full_path, f.diary_name,
                 f.updated_at, f.mtime
          FROM files f
          JOIN chunks c ON c.file_id = f.id
          WHERE f.path IN (${placeholders})
          ORDER BY c.chunk_index
        `).all(...batch));
      } catch (e) {
        continue;
      }
    }

    return rows.map(row => ({
      chunkId: Number(row.chunk_id),
      chunkIndex: Number(row.chunk_index),
      text: row.content,
      content: row.content,
      fileId: Number(row.file_id),
      fullPath: String(row.full_path || ''),
      sourceFile: String(row.full_path || '') ? path.basename(String(row.full_path)) : '',
      diaryName: String(row.diary_name || ''),
      updatedAt: row.updated_at != null ? Number(row.updated_at) : null,
      mtime: row.mtime != null ? Number(row.mtime) : null,
      vector: row.vector != null ? this._decodeChunkVector(row.vector) : null
    }));
  }
}

module.exports = KnowledgeBaseAdapter;