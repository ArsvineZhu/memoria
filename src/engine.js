'use strict';

const { DEFAULT_CONFIG, mergeConfig } = require('./config/default-config');
const { loadRagParams } = require('./config/rag-params-loader');
const PipelineContext = require('./core/context');
const IngestPipeline = require('./pipelines/ingest-pipeline');
const DeletePipeline = require('./pipelines/delete-pipeline');
const SearchPipeline = require('./pipelines/search-pipeline');
const OpenAIEmbeddingProvider = require('./providers/openai-embedding-provider');
const VexusVectorStore = require('./providers/vexus-vector-store');
const SqliteMetadataStore = require('./providers/sqlite-metadata-store');

/**
 * Normalize `flush(files)` inputs into an array of file entries.
 * Accepted: undefined, a single entry object, an entry array, or plain
 * path strings (the watcher-batch shape).
 * @param {any} files
 * @returns {Array<object>}
 * @private
 */
function normalizeFiles(files) {
  if (files == null) return [];
  const list = Array.isArray(files) ? files : [files];
  return list.map(entry =>
    typeof entry === 'string' ? { path: entry } : (entry || {})
  );
}

/**
 * MemoryEngine — the standalone knowledge-base engine.
 *
 * Wires the pipelines, providers and PipelineContext together and exposes
 * the lifecycle/ingest/search/delete/statistics surface used by
 * KnowledgeBaseManager consumers (server.js, plugins, admin routes).
 *
 * Usage:
 *   const engine = createMemoryEngine({
 *     config: { dimension: 3072, rootPath: ..., apiUrl, apiKey, model },
 *     dbPath: 'knowledge_base.sqlite',
 *     ragParamsPath: 'rag_params.json'
 *   });
 *   await engine.initialize();
 *   await engine.flushBatch([{ path: '/abs/note.md' }]);
 *   const { results } = await engine.search('量子计算');
 *   await engine.handleDelete({ path: '/abs/note.md' });
 *   await engine.close();
 */
class MemoryEngine {
  /**
   * @param {object} [options={}]
   * @param {object} [options.config]          - merged over DEFAULT_CONFIG
   * @param {string} [options.dbPath]          - SQLite path (default ':memory:')
   * @param {string} [options.ragParamsPath]   - rag_params.json (optional)
   * @param {object} [options.ragParams]       - rag params overrides (optional)
   * @param {import('./interfaces/embedding-provider')} [options.embeddingProvider]
   * @param {import('./interfaces/vector-store')} [options.vectorStore]
   * @param {import('./interfaces/metadata-store')} [options.metadataStore]
   * @param {object} [options.ctx]             - extra PipelineContext fields
   *                                             (vexusIndex, epa, tagGraph, ...)
   * @param {object} [options.ingestOptions]   - forwarded to IngestPipeline (stages...)
   * @param {object} [options.deleteOptions]   - forwarded to DeletePipeline
   * @param {object} [options.searchOptions]   - forwarded to SearchPipeline
   */
  constructor(options = {}) {
    this.name = 'memoryEngine';
    this.options = options || {};

    // 1. Merged configuration (providers read from here).
    this.config = mergeConfig(options.config);
    if (options.dbPath !== undefined && this.config.dbPath === ':memory:') {
      this.config.dbPath = options.dbPath;
    }

    // 2. Providers — injected instances win; otherwise build the defaults.
    this.metadataStore = options.metadataStore || new SqliteMetadataStore({
      dbPath: this.config.dbPath,
      dimension: this.config.dimension,
      busyTimeout: this.config.busyTimeout,
      busyRetryDelay: this.config.busyRetryDelay
    });
    this.vectorStore = options.vectorStore || new VexusVectorStore({
      dimension: this.config.dimension,
      storePath: this.config.storePath,
      tagIndexCapacity: this.config.tagIndexCapacity,
      indexSaveDelay: this.config.indexSaveDelay,
      tagIndexSaveDelay: this.config.tagIndexSaveDelay,
      persistTagIndex: this.config.persistTagIndex
    });
    this.embeddingProvider = options.embeddingProvider || new OpenAIEmbeddingProvider({
      apiUrl: this.config.apiUrl,
      apiKey: this.config.apiKey,
      model: this.config.model,
      modelSig: this.config.modelSig,
      dimension: this.config.dimension,
      maxBatchItems: this.config.maxBatchItems,
      maxToken: this.config.maxToken,
      concurrency: this.config.concurrency,
      fallbackModels: this.config.fallbackModels
    });

    // 3. Shared pipeline context (DI container for every stage).
    this.ctx = new PipelineContext({
      config: this.config,
      embeddingProvider: this.embeddingProvider,
      vectorStore: this.vectorStore,
      metadataStore: this.metadataStore,
      ...(options.ctx || {})
    });

    // 4. Pipelines.
    this.ingestPipeline = new IngestPipeline(this.config, options.ingestOptions || {});
    this.deletePipeline = new DeletePipeline(this.config, options.deleteOptions || {});
    this.searchPipeline = new SearchPipeline(this.config, options.searchOptions || {});

    // 5. Lifecycle + session statistics.
    this.initialized = false;
    this._initPromise = null;
    this._closed = false;
    this.ragParams = {};
    this._lastIndexedAt = null;
  }

  /**
   * Open the engine: load rag params, apply hot knobs to the config and
   * mark the engine ready. Idempotent (concurrent calls share one run).
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) return this._initPromise || undefined;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      const { ragParamsPath, ragParams: ragOverrides } = this.options;
      this.ragParams = await loadRagParams({
        path: ragParamsPath,
        overrides: ragOverrides
      });

      this._applyRagParamsToConfig(this.ragParams);
      if (this.options.onReady && typeof this.options.onReady === 'function') {
        await this.options.onReady(this);
      }
      this.initialized = true;
    })();

    await this._initPromise;
    return undefined;
  }

  /**
   * Map hot-tunable rag phi into the pipeline config so the dedupe stage
   * reflects rag_params.json without a rebuild.
   * @private
   */
  _applyRagParamsToConfig(ragParams) {
    const section = ragParams && ragParams.KnowledgeBaseManager;
    if (!section || typeof section !== 'object') return;

    const dedupe = section.resultDeduplication;
    if (dedupe && typeof dedupe === 'object') {
      if (dedupe.semanticThreshold != null) {
        this.config.semanticThreshold = dedupe.semanticThreshold;
      }
      if (dedupe.maxResults != null) {
        this.config.dedupeMaxResults = dedupe.maxResults;
        this.config.maxResults = dedupe.maxResults;
      }
      if (dedupe.minSemanticCandidates != null) {
        this.config.minSemanticCandidates = dedupe.minSemanticCandidates;
      }
      if (dedupe.finalSemanticThreshold != null) {
        this.config.finalSemanticThreshold = dedupe.finalSemanticThreshold;
      }
      if (dedupe.sourcePriority && typeof dedupe.sourcePriority === 'object') {
        this.config.sourcePriority = {
          ...this.config.sourcePriority,
          ...dedupe.sourcePriority
        };
      }
    }

    const riverMemo = section.riverMemo;
    if (riverMemo && typeof riverMemo === 'object' && riverMemo.enabled === true) {
      this.config.riverMemoEnabled = true;
    }
  }

  /**
   * Ingest a batch of files into the knowledge base.
   * @param {Array<{path:string, relPath?:string, content?:string, mtime?:number, size?:number}>|
   *              {path:string, ...}|undefined} files
   * @returns {Promise<Array<object>>} per-file ingest envelopes
   */
  async flushBatch(files) {
    const entries = normalizeFiles(files);
    const results = [];
    for (const entry of entries) {
      const result = await this.ingestPipeline.run(
        {
          path: entry.path,
          relPath: entry.relPath,
          content: entry.content,
          mtime: entry.mtime,
          size: entry.size
        },
        this.ctx
      );
      results.push(result);
      if (result && !result.skipped && result.fileId != null) {
        this._lastIndexedAt = Date.now();
      }
    }
    return results;
  }

  /**
   * Alias of {@link flushBatch} (knowledgeBase.flush call shape).
   * @param {Array|object|undefined} files
   * @returns {Promise<Array<object>>}
   */
  flush(files) {
    return this.flushBatch(files);
  }

  /**
   * Hybrid search. Returns the full result envelope produced by the
   * ResultFormatterStage: { ..., results: [...], resultCount }.
   *
   * @param {string|object} query - raw query string, or an envelope
   *                                ({ query, options }) for fine control
   * @param {object} [options]    - per-call options (topK, diaryNames, ...)
   * @returns {Promise<object>}   - { ..., results, resultCount }
   */
  async search(query, options = {}) {
    const input = { ...(typeof query === 'object' && query !== null && !Array.isArray(query) ? query : { query }) };
    if (!input.query && typeof query === 'string') input.query = query;
    input.options = { ...options, ...(input.options || {}) };
    return this.searchPipeline.run(input, this.ctx);
  }

  /**
   * Remove a file from metadata + vector indices.
   * @param {{path:string}|string} input
   * @returns {Promise<object>} delete envelope { deleted, fileId, removedChunkIds, ... }
   */
  async handleDelete(input) {
    const source = typeof input === 'string' ? { path: input } : (input || {});
    return this.deletePipeline.run(
      { path: source.path, relPath: source.relPath },
      this.ctx
    );
  }

  /**
   * Convenience alias of handleDelete({ path }).
   * @param {string} filePath
   * @returns {Promise<object>}
   */
  deleteFile(filePath) {
    return this.handleDelete({ path: filePath });
  }

  /**
   * Knowledge base statistics.
   * @returns {Promise<{files:number, chunks:number, tags:number,
   *   diaries:string[], lastIndexed:number|null, vectorStats:object,
   *   healthy:boolean, initialized:boolean}>}
   */
  async getStats() {
    const store = this.metadataStore;
    const chunks = (await store.getAllChunks()) || [];
    const tags = (await store.getAllTags()) || [];
    const diaries = await store.getDistinctDiaryNames();

    const files = await this._countFiles();
    const lastIndexed = await this._resolveLastIndexed();

    let vectorStats = { totalVectors: 0, indices: 0, dimension: this.config.dimension };
    if (typeof this.vectorStore.getIndexStats === 'function') {
      let total = 0;
      let count = 0;
      if (this.vectorStore.indices instanceof Map) {
        for (const name of this.vectorStore.indices.keys()) {
          const stats = await this.vectorStore.getIndexStats(name);
          total += Number(stats && stats.size) || 0;
          count += 1;
        }
      }
      vectorStats = { ...vectorStats, totalVectors: total, indices: count };
    }

    let healthy = { healthy: true, issues: [] };
    if (typeof store.healthCheck === 'function') {
      try {
        healthy = await store.healthCheck();
      } catch (e) {
        healthy = { healthy: false, issues: [e && e.message || String(e)] };
      }
    }

    return {
      files,
      chunks: chunks.length,
      tags: tags.length,
      diaries: Array.isArray(diaries) ? diaries : [],
      lastIndexed: lastIndexed,
      vectorStats,
      healthy,
      initialized: this.initialized
    };
  }

  /**
   * Number of stored files. Raw SQLite is preferred when the default
   * provider is in use; a chunk-derived estimate is the fallback.
   * @private
   */
  async _countFiles() {
    const store = this.metadataStore;
    if (store.db && typeof store.db.prepare === 'function') {
      try {
        const row = store.db.prepare('SELECT COUNT(*) AS c FROM files').get();
        return Number(row && row.c) || 0;
      } catch (e) {
        // Fall through to the interface query below.
      }
    }
    if (typeof store.getChunksByFileId !== 'function') return 0;
    const chunks = await store.getAllChunks();
    return new Set(chunks.map(c => Number(c.fileId)).filter(Number.isFinite)).size;
  }

/**
   * Latest ingest time (wall-clock of the most recently flushed file,
   * or the db-side MAX(files.updated_at) when raw SQLite is available).
   * @private
   */
  async _resolveLastIndexed() {
    const store = this.metadataStore;
    if (store.db && typeof store.db.prepare === 'function') {
      try {
        const row = store.db.prepare('SELECT MAX(updated_at) AS m FROM files').get();
        if (row && row.m != null) return Number(row.m) * 1000;
      } catch (e) {
        // fall back to the session-level timestamp
      }
    }
    return this._lastIndexedAt;
  }

  /**
   * Shut the engine down: flush pending vector saves, close the stores.
   * Idempotent.
   * @returns {Promise<void>}
   */
  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this.vectorStore && typeof this.vectorStore.flushPendingSaves === 'function') {
      try {
        this.vectorStore.flushPendingSaves();
      } catch (e) {
        // Index persistence failures must not block shutdown.
        console.error(`[MemoryEngine] flush pending saves failed: ${e.message}`);
      }
    }
    if (this.metadataStore && typeof this.metadataStore.close === 'function') {
      this.metadataStore.close();
    }
  }
}

/**
 * Factory entry-point: build (but do not open) a MemoryEngine.
 * @param {object} [options]
 * @returns {MemoryEngine}
 */
function createMemoryEngine(options) {
  return new MemoryEngine(options);
}

module.exports = { MemoryEngine, createMemoryEngine };