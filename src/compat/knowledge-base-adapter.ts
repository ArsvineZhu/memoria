"use strict";

import * as path from "node:path";

import ResultDeduplicator from "../algorithms/result-deduplicator.js";
import { decodeVectorBlob } from "../utils/vector-codec.js";
import { EPA } from "../algorithms/epa.js";
import type { EngineStats, MemoryEngine } from "../engine.js";
import GeodesicRerankerStage from "../stages/memo/geodesic-reranker.js";
import NativeMemoRuntimeStage from "../stages/memo/native-memo-runtime.js";
import TagMemoV10Stage from "../stages/memo/tagmemo-v10.js";
import TagMemoV9Stage from "../stages/memo/tagmemo-v9.js";
import TopologyV3Stage from "../stages/memo/topology-v3.js";
import type {
  ChunkCandidate,
  ChunkRow,
  DatabaseLike,
  EpaAnalysis,
  EpaProjectResult,
  FileInput,
  FileRow,
  MemoryConfig,
  MetadataStoreContract,
  PipelineContextLike,
  PipelineData,
  SearchEnvelope,
  SearchOptions,
  SearchResult,
  TagBoostEnvelope,
  TagRow,
  UnknownRecord,
  VectorHit,
  VectorLike,
} from "../types.js";

type FlushInput = FileInput | readonly FileInput[] | string;
type MetadataStoreWithDb = MetadataStoreContract & { db?: DatabaseLike };
type CompatResult = SearchResult & {
  fullPath?: string;
  matchedTags?: string[];
  tagMatchCount?: number;
  coreTagsMatched?: string[];
  boostFactor?: number;
  tagMatchScore?: number;
};
type CompatChunk = {
  chunkId: number;
  chunkIndex: number;
  text: string;
  content: string;
  fileId: number;
  fullPath: string;
  sourceFile: string;
  diaryName: string;
  updatedAt: number | null;
  mtime: number | null;
  vector: Float32Array | null;
};
type MutationOperation = () => unknown | Promise<unknown>;
type EpaCache = { epa: EPA; dimension: number; indexedAt: number | null };
type IndexLike = { stats(): UnknownRecord };
type DateIndexEntry = {
  relativePath: string;
  date: string | null;
  diaryDate: Date | null;
};
type ChunkQueryRow = {
  chunk_id: number;
  chunk_index: number;
  content: string;
  vector: Buffer | null;
  file_id: number;
  full_path: string;
  diary_name: string;
  updated_at?: number | null;
  mtime?: number | null;
};

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeCompatCandidates(
  candidates: readonly SearchResult[],
): ChunkCandidate[] {
  return (Array.isArray(candidates) ? candidates : []).map((candidate, index) => {
    const source = isRecord(candidate) ? candidate : {};
    const rawTags = source.tags ?? source.matchedTags;
    const tags = Array.isArray(rawTags) ? rawTags.map(String) : undefined;
    const rawChunkId = source.chunkId ?? source.id;
    const chunkId = finiteNumber(rawChunkId, index + 1);
    return {
      ...source,
      chunkId,
      score: finiteNumber(source.score),
      ...(tags ? { tags } : {}),
    } as ChunkCandidate;
  });
}

function compatQueryInput(
  query: UnknownRecord,
  candidates: readonly ChunkCandidate[],
  options: UnknownRecord,
): PipelineData {
  const rawVector = query.vector;
  const queryVector =
    rawVector instanceof Float32Array || Array.isArray(rawVector)
      ? rawVector
      : undefined;
  const input: PipelineData = {
    query: typeof query.text === "string" ? query.text : String(query.query || ""),
    ...(queryVector ? { queryVector } : {}),
    mergedCandidates: [...candidates],
    options,
  };

  const explicitCoreTags = Array.isArray(options.coreTags)
    ? options.coreTags.map(String).filter(Boolean)
    : [];
  if (explicitCoreTags.length > 0) input.coreTags = explicitCoreTags;

  // applyTagBoostAsync returns this object so the old two-call LightMemo
  // flow can share one native observation instead of rebuilding it.
  const prepared = isRecord(options.preparedMemoObservation)
    ? options.preparedMemoObservation
    : null;
  const nativeMemo =
    prepared && isRecord(prepared.nativeMemo) ? prepared.nativeMemo : null;
  const artifact = prepared && isRecord(prepared.artifact) ? prepared.artifact : null;
  if (prepared && nativeMemo && artifact && typeof artifact.artifactSig === "string") {
    const observation = isRecord(nativeMemo.observation) ? nativeMemo.observation : {};
    const activations = new Map<number, number>();
    for (const rawNode of Array.isArray(observation.nodes) ? observation.nodes : []) {
      if (!isRecord(rawNode)) continue;
      const id = finiteNumber(rawNode.id, NaN);
      const energy = finiteNumber(rawNode.energy, 0);
      if (Number.isFinite(id) && energy > 0) activations.set(id, energy);
    }
    const originalVector =
      prepared.queryVector instanceof Float32Array ||
      Array.isArray(prepared.queryVector)
        ? prepared.queryVector
        : queryVector;
    const enhancedVector =
      prepared.enhancedVector instanceof Float32Array ||
      Array.isArray(prepared.enhancedVector)
        ? prepared.enhancedVector
        : nativeMemo.enhancedVector;
    input.nativeMemo = nativeMemo;
    input.nativeMemoArtifact = artifact;
    input.nativeMemoSkipped = false;
    input.nativeQueryVector = originalVector;
    if (enhancedVector instanceof Float32Array || Array.isArray(enhancedVector)) {
      input.queryVector = enhancedVector;
    }
    input.tagMemo = {
      version: "v10",
      nativeBackend: "rust-shared-memo-runtime",
      activations,
      nativeObservation: observation,
    };
  }
  return input;
}

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
 *   host app integration:              kbm.db.prepare(...), kbm.search(diary, vec, n),
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
 * falls back gracefully when the method is absent. The legacy async rerank
 * names are retained as adapters over the library's native Memo stages; if a
 * native dependency is unavailable, the adapter returns the original pool
 * with a diagnostic envelope instead of claiming that a rerank happened.
 *
 * The legacy search(diaryName, vec, k, tagBoost) vector path is a plain
 * per-index KNN + hydration pass. Text queries (`search(str)`) delegate to
 * the MemoryEngine search pipeline, whose optional geodesic reranking and
 * associator stages are controlled by the normal config gates.
 */
class KnowledgeBaseAdapter {
  name: string;
  engine: MemoryEngine;
  flush: (files?: FlushInput) => Promise<UnknownRecord[]>;
  flushBatch: (files?: FlushInput) => Promise<UnknownRecord[]>;
  handleDelete: (input: string | FileInput) => Promise<UnknownRecord>;
  deleteFile: (filePath: string) => Promise<UnknownRecord>;
  getStats: () => Promise<EngineStats>;
  close: () => Promise<void>;
  _mutationTail: Promise<unknown>;
  _mutationOwner: string | null = null;
  _epaCache: EpaCache | null;
  _resultDeduplicator?: ResultDeduplicator;
  /**
   * @param {object} options
   * @param {import('../engine.js').MemoryEngine} options.engine
   */
  constructor({ engine }: { engine?: MemoryEngine } = {}) {
    if (!engine) {
      throw new TypeError("KnowledgeBaseAdapter requires an engine");
    }
    this.name = "knowledgeBaseAdapter";
    this.engine = engine;

    // ── Call-site passthroughs ──────────────────────────────────────
    this.flush = (files?: FlushInput) => {
      this._invalidateCaches();
      return engine.flush(files);
    };
    this.flushBatch = (files?: FlushInput) => {
      this._invalidateCaches();
      return engine.flushBatch(files);
    };
    this.handleDelete = (input: string | FileInput) => {
      this._invalidateCaches();
      return engine.handleDelete(input);
    };
    this.deleteFile = (filePath: string) => {
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
  get db(): DatabaseLike | null {
    const store =
      this.engine && (this.engine.metadataStore as unknown as MetadataStoreWithDb);
    return (store && store.db) || null;
  }

  /** toolExecutor / DreamWaveEngine surface: merged engine config. */
  get config(): MemoryConfig {
    return this.engine.config;
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
   * @param {(operation: () => unknown | Promise<unknown>)} operation
   * @param {object} [options]
   * @returns {Promise<unknown>} operation result
   */
  runExternalFileMutation(
    owner: string,
    operation: MutationOperation,
    _options: UnknownRecord = {},
  ): Promise<unknown> {
    if (typeof operation !== "function") {
      return Promise.reject(
        new TypeError("runExternalFileMutation requires an operation function"),
      );
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
      for (const index of (vectorStore.indices as Map<string, IndexLike>).values()) {
        indices += 1;
        if (!index || typeof index.stats !== "function") continue;
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
      dimension,
    };
  }

  /**
   * routes/admin/rag.js reads getHealthStatus() synchronously.
   * @returns {{status:string, healthy:boolean, issues:string[]}}
   */
  getHealthStatus() {
    const store =
      this.engine && (this.engine.metadataStore as unknown as MetadataStoreWithDb);
    if (!store) {
      return { status: "unavailable", healthy: false, issues: [] };
    }
    const issues: string[] = [];
    try {
      if (store.db && typeof store.db.prepare === "function") {
        store.db.prepare("SELECT 1").get();
      }
    } catch (e) {
      issues.push(e instanceof Error ? e.message : String(e));
    }
    return {
      status: issues.length === 0 ? "healthy" : "degraded",
      healthy: issues.length === 0,
      issues,
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
  async search(query: string, options?: SearchOptions): Promise<SearchEnvelope>;
  async search(
    indexNames: string | readonly string[],
    queryVector: VectorLike,
    k?: number,
    tagBoost?: unknown,
  ): Promise<CompatResult[]>;
  async search(
    queryVector: VectorLike,
    k?: number,
    tagBoost?: unknown,
  ): Promise<CompatResult[]>;
  async search(...args: unknown[]): Promise<SearchEnvelope | CompatResult[]> {
    const [arg1, arg2] = args;
    const isDiaryNameArray =
      Array.isArray(arg1) &&
      arg1.every((name): name is string => typeof name === "string");
    if ((typeof arg1 === "string" || isDiaryNameArray) && this._isVectorLike(arg2)) {
      return this._vectorSearch(
        isDiaryNameArray ? arg1 : [arg1 as string],
        arg2,
        Number(args[2]) || 5,
        args[3] || 0,
      );
    }
    if (this._isVectorLike(arg1)) {
      const names = await this._vectorIndexNames();
      return this._vectorSearch(names, arg1, Number(args[1]) || 5, args[2] || 0);
    }
    // Text search falls back to the engine pipeline.
    return this.engine.search(
      String(arg1 || ""),
      typeof arg2 === "object" && arg2 !== null && !Array.isArray(arg2)
        ? (arg2 as SearchOptions)
        : {},
    );
  }

  /**
   * Resolve the set of vector index names searchable for a legacy query.
   * @private
   */
  async _vectorIndexNames(): Promise<string[]> {
    const engine = this.engine;
    if (
      engine.vectorStore &&
      engine.vectorStore.indices instanceof Map &&
      engine.vectorStore.indices.size > 0
    ) {
      return [...engine.vectorStore.indices.keys()];
    }
    try {
      const names = await engine.metadataStore.getDistinctDiaryNames();
      return names && names.length ? names : ["Root"];
    } catch (e) {
      return ["Root"];
    }
  }

  _isVectorLike(value: unknown): value is VectorLike {
    return (
      Array.isArray(value) ||
      value instanceof Float32Array ||
      (ArrayBuffer.isView(value) &&
        typeof (value as unknown as ArrayLike<unknown>).length === "number")
    );
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
  async _vectorSearch(
    indexNames: readonly string[],
    queryVector: VectorLike,
    k: number,
    _tagBoost: unknown,
  ): Promise<CompatResult[]> {
    const engine = this.engine;
    const vectorStore = engine.vectorStore;
    const store = engine.metadataStore;
    if (!vectorStore || typeof vectorStore.search !== "function") return [];

    const query =
      queryVector instanceof Float32Array ? queryVector : new Float32Array(queryVector);

    const bestById = new Map<number, { chunkId: number; score: number }>();
    for (const indexName of indexNames) {
      let results: VectorHit[] = [];
      try {
        results = await vectorStore.search(
          indexName,
          query,
          Math.max(1, Math.round(k)),
        );
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

    const hydrated: CompatResult[] = [];
    for (const { chunkId, score } of bestById.values()) {
      let chunk: ChunkRow | null = null;
      try {
        chunk = await store.getChunkById(chunkId);
      } catch (e) {
        continue;
      }
      const row: FileRow | null =
        chunk && chunk.fileId != null ? await store.getFileByChunkId(chunk.id) : null;
      const fullPath = row && row.path ? row.path : "";
      let tagNames: string[] = [];
      if (row) {
        try {
          const tags = await store.getFileTags(row.id);
          tagNames = Array.isArray(tags)
            ? tags.map((t) => (t && t.name) || String(t))
            : [];
        } catch (e) {
          tagNames = [];
        }
      }
      hydrated.push({
        chunkId,
        text: chunk ? chunk.content : "",
        score,
        sourceFile: fullPath ? path.basename(fullPath) : "",
        fullPath,
        matchedTags: tagNames,
        tagMatchCount: tagNames.length,
        coreTagsMatched: [],
        boostFactor: 0,
        tagMatchScore: 0,
      });
    }

    hydrated.sort((a, b) => b.score - a.score || Number(a.chunkId) - Number(b.chunkId));
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
  removeDocument(filePath: string): Promise<unknown> {
    this._invalidateCaches();
    return this.engine.deleteFile(String(filePath || ""));
  }

  /**
   * Drop caches whose validity depends on the ingested corpus.
   * @private
   */
  _invalidateCaches() {
    this._epaCache = null;
  }

  async _compatTagGraph(): Promise<Map<number, Map<number, number>>> {
    const fromContext = this.engine.ctx?.tagGraph;
    if (fromContext instanceof Map) return fromContext;
    const store = this.engine.metadataStore;
    if (store && typeof store.buildCooccurrenceMatrix === "function") {
      try {
        return await store.buildCooccurrenceMatrix();
      } catch (_) {
        // The caller still receives the original candidates and an explicit
        // unavailable diagnostic from the compatibility rerank method.
      }
    }
    return new Map();
  }

  _compatContext(
    configOverrides: UnknownRecord,
    tagGraph?: Map<number, Map<number, number>>,
  ): PipelineContextLike {
    return {
      ...(this.engine.ctx || {}),
      config: { ...this.engine.config, ...configOverrides },
      embeddingProvider: this.engine.embeddingProvider,
      vectorStore: this.engine.vectorStore,
      metadataStore: this.engine.metadataStore,
      ...(tagGraph ? { tagGraph } : {}),
    } as PipelineContextLike;
  }

  /**
   * RAGDiaryPlugin surface: unified result deduplication (exact identity
   * + optional semantic suppression), mirroring KnowledgeBaseManager.
   * @param {Array<object>} candidates
   * @param {Float32Array|Array<number>|null} queryVector
   * @param {object} options - { semantic, semanticThreshold, maxResults, stage }
   * @returns {Promise<Array<object>>}
   */
  async deduplicateResults(
    candidates: readonly SearchResult[],
    queryVector: VectorLike | null = null,
    options: UnknownRecord = {},
  ): Promise<SearchResult[]> {
    if (!Array.isArray(candidates) || candidates.length === 0) return [];
    const deduplicator = this._resultDeduplicator || this._createResultDeduplicator();
    this._resultDeduplicator = deduplicator;
    try {
      return (await deduplicator.deduplicate(
        candidates,
        queryVector,
        options as Parameters<ResultDeduplicator["deduplicate"]>[2],
      )) as unknown as SearchResult[];
    } catch (error) {
      console.warn(
        `[KnowledgeBaseAdapter] deduplicateResults failed at stage=${String(options.stage || "unknown")}; ` +
          `falling back to exact deduplication: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        return deduplicator.hardDeduplicate(candidates) as unknown as SearchResult[];
      } catch (fallbackError) {
        console.warn(
          `[KnowledgeBaseAdapter] Exact deduplication fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        );
        return candidates;
      }
    }
  }

  /**
   * @private
   */
  _createResultDeduplicator(): ResultDeduplicator {
    const engine = this.engine;
    const store = engine && engine.metadataStore;
    const dimension =
      Number(engine && engine.config && engine.config.dimension) || 3072;
    const loadVector = store
      ? async (chunkId: number) => {
          const row = await store.getChunkById(chunkId);
          return row?.vector
            ? decodeVectorBlob(row.vector, dimension, `chunk ${chunkId}`, {
                logPrefix: "Memoria adapter deduplication",
              })
            : null;
        }
      : undefined;
    return new ResultDeduplicator(loadVector, {
      dimension,
    });
  }

  /**
   * RAGDiaryPlugin surface: EPA semantic depth analysis for a query vector.
   * Builds (and caches) an EPA basis from the stored tag store; falls back
   * to the KnowledgeBaseManager neutral envelope when the basis is
   * unavailable. `resonance` is always a number.
   * @param {Array|Float32Array} vector
   * @returns {Promise<{logicDepth:number, resonance:number, entropy:number, dominantAxes:Array}>}
   */
  async getEPAAnalysis(vector: VectorLike): Promise<EpaAnalysis> {
    const fallback = { logicDepth: 0.5, resonance: 0, entropy: 0.5, dominantAxes: [] };
    if (!vector || typeof vector.length !== "number" || vector.length === 0) {
      return fallback;
    }

    const epa = await this._getEpa();
    if (!epa) return fallback;

    try {
      const projection = epa.project(vector);
      const resonanceInfo = epa.detectCrossDomainResonance(vector);
      const resonance = Number(
        resonanceInfo && resonanceInfo.resonance != null ? resonanceInfo.resonance : 0,
      );
      return {
        logicDepth: Number(projection.logicDepth) || 0,
        resonance: Number.isFinite(resonance) ? resonance : 0,
        entropy: Number(projection.entropy) || 1,
        dominantAxes: projection.dominantAxes || [],
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
  async _getEpa(): Promise<EPA | null> {
    const engine = this.engine;
    const store = engine && engine.metadataStore;
    const dimension = Number(engine && engine.config && engine.config.dimension) || 0;
    if (!store || typeof store.getAllTags !== "function" || dimension <= 0) return null;

    if (
      this._epaCache &&
      this._epaCache.dimension === dimension &&
      this._epaCache.indexedAt === engine._lastIndexedAt
    ) {
      return this._epaCache.epa;
    }

    let tags: TagRow[] = [];
    try {
      tags = await store.getAllTags();
    } catch (e) {
      return null;
    }
    const withVectors = (tags || []).filter(
      (tag): tag is TagRow & { vector: Buffer | Float32Array } => tag.vector != null,
    );
    if (withVectors.length < 2) return null;

    let basis;
    try {
      basis = EPA.computeBasis(withVectors, dimension, {
        clusterCount: Math.min(64, withVectors.length),
        maxBasisDim: Math.min(64, dimension),
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
   * The standalone library keeps this legacy vector-envelope method safe for
   * callers that only need a query vector. Full TagMemo+/RiverMemo readout is
   * exposed by the typed retrieval plan and by the async rerank adapters
   * below; this method does not mutate a caller-owned vector in place.
   *
   * @param {Array|Float32Array} vector - query vector
   * @param {number} [tagBoost=0]
   * @param {Array<string>} [coreTags=[]]
   * @param {number} [coreBoostFactor=1.33]
   * @param {object} [options={}]
   * @returns {Promise<object>} boost envelope
   */
  async applyTagBoostAsync(
    vector: VectorLike | null | undefined,
    tagBoost = 0,
    coreTags: readonly string[] = [],
    coreBoostFactor = 1.33,
    options: UnknownRecord = {},
  ): Promise<TagBoostEnvelope> {
    const source =
      vector instanceof Float32Array ? vector : new Float32Array(vector || []);

    const controls = isRecord(options) ? options : {};
    const ctx = this._compatContext({
      nativeMemoEnabled: true,
      tagMemoV9Enabled: true,
      tagMemoV10Enabled: true,
      baseTagBoost: Math.max(0, finiteNumber(tagBoost)),
      coreBoostFactor: Math.max(0, finiteNumber(coreBoostFactor, 1.33)),
    });
    const output = await new NativeMemoRuntimeStage().process(
      {
        query: String(controls.queryText || ""),
        queryVector: source,
        ...(coreTags.length > 0 ? { coreTags: [...coreTags] } : {}),
      },
      ctx,
    );
    const nativeMemo = isRecord(output.nativeMemo) ? output.nativeMemo : null;
    const rawEnhanced = nativeMemo?.enhancedVector;
    const enhanced =
      rawEnhanced instanceof Float32Array || Array.isArray(rawEnhanced)
        ? Array.from(rawEnhanced as ArrayLike<number>, (value) => finiteNumber(value))
        : [];

    if (
      nativeMemo &&
      output.nativeMemoSkipped === false &&
      enhanced.length === source.length
    ) {
      const observation = isRecord(nativeMemo?.observation)
        ? nativeMemo.observation
        : {};
      const nodes = Array.isArray(observation.nodes) ? observation.nodes : [];
      const energyField = new Map<number, number>();
      const energyFieldProvenance = new Map<number, UnknownRecord>();
      for (const rawNode of nodes) {
        if (!isRecord(rawNode)) continue;
        const id = finiteNumber(rawNode.id, NaN);
        if (!Number.isFinite(id)) continue;
        energyField.set(id, Math.max(0, finiteNumber(rawNode.energy)));
        energyFieldProvenance.set(id, { ...rawNode });
      }
      const matchedTags = Array.isArray(nativeMemo.matchedTags)
        ? nativeMemo.matchedTags.map(String)
        : [];
      const coreTagsMatched = Array.isArray(nativeMemo.coreTagsMatched)
        ? nativeMemo.coreTagsMatched.map(String)
        : [];
      const preparedMemoObservation = {
        observation,
        nativeMemo,
        artifact: output.nativeMemoArtifact || null,
        queryVector: new Float32Array(source),
        enhancedVector: new Float32Array(enhanced),
      };
      return {
        vector: new Float32Array(enhanced),
        info: {
          matchedTags,
          coreTagsMatched,
          boostFactor: Math.max(
            0,
            finiteNumber(nativeMemo.effectiveTagBoost, finiteNumber(tagBoost)),
          ),
          tagBoost: finiteNumber(tagBoost),
          tagMatchScore: matchedTags.length > 0 ? 1 : 0,
        },
        energyField,
        energyFieldProvenance,
        artifactBundle: output.nativeMemoArtifact || null,
        preparedMemoObservation,
      };
    }

    return {
      vector: new Float32Array(source),
      info: {
        matchedTags: [],
        coreTagsMatched: [],
        boostFactor: 0,
        tagBoost: Number(tagBoost) || 0,
        tagMatchScore: 0,
      },
      energyField: null,
      energyFieldProvenance: null,
      artifactBundle: null,
      preparedMemoObservation: null,
    };
  }

  /**
   * LightMemo surface: TagMemo+ compatibility adapter. It runs the shared
   * native Memo observation when available, then falls back to the TypeScript
   * V9/V10 field stages and geodesic readout when the native backend is not
   * available (for example, with an in-memory SQLite database).
   * @param {{text:string, vector:Float32Array}} query
   * @param {Array<object>} candidates
   * @param {object} [options]
   * @param {object} [meta]
   * @returns {Promise<{results:Array<object>, meta:object|null}>}
   */
  async rerankWithTagMemoAsync(
    query: UnknownRecord,
    candidates: readonly SearchResult[],
    _options: UnknownRecord = {},
    _meta: UnknownRecord = {},
  ): Promise<{ results: SearchResult[]; meta: UnknownRecord | null }> {
    const source = Array.isArray(candidates) ? candidates : [];
    if (source.length === 0) return { results: [], meta: null };

    const options = {
      ...(isRecord(_options) ? _options : {}),
      ...(isRecord(_meta) ? _meta : {}),
    };
    const graph = await this._compatTagGraph();

    const minGeoSamples = Math.max(
      1,
      Math.round(
        finiteNumber(
          options.minGeoSamples ?? options.geodesicMinGeoSamples,
          finiteNumber(this.engine.config.geodesicMinGeoSamples, 1),
        ),
      ),
    );
    const normalized = normalizeCompatCandidates(source);
    const ctx = this._compatContext(
      {
        tagMemoV9Enabled: true,
        tagMemoV10Enabled: true,
        geodesicRerankEnabled: true,
        geodesicMinGeoSamples: minGeoSamples,
        // Let the native stage opportunistically run. It marks itself skipped
        // on unsupported stores, after which the TS field stages take over.
        nativeMemoEnabled: true,
      },
      graph,
    );
    const input = compatQueryInput(query, normalized, options);
    let output =
      input.nativeMemoSkipped === false
        ? input
        : await new NativeMemoRuntimeStage().process(input, ctx);
    if (output.nativeMemoSkipped !== false && graph.size === 0) {
      return {
        results: [...source],
        meta: {
          strategy: "field",
          available: false,
          reason: "TagMemo tag graph is unavailable",
        },
      };
    }
    output = await new TagMemoV9Stage().process(output, ctx);
    output = await new TagMemoV10Stage().process(output, ctx);
    output = await new GeodesicRerankerStage().process(output, ctx);

    const reranked = Array.isArray(output.mergedCandidates)
      ? (output.mergedCandidates as SearchResult[])
      : source;
    const tagMemoVersion = output.tagMemo?.version;
    const geodesicVersion = output.geodesic?.version;
    const skipped =
      output.tagMemoV10Skipped === true ||
      output.tagMemoSkipped === true ||
      output.geodesicSkipped === true;
    return {
      results: reranked,
      meta: {
        strategy: "field",
        available: tagMemoVersion === "v10" && !skipped,
        tagMemoVersion: tagMemoVersion || null,
        geodesicVersion: geodesicVersion || null,
        geodesic: output.geodesic || null,
        native: output.nativeMemoSkipped === false,
        skipped,
        reason:
          output.nativeMemoSkipReason ||
          output.geodesicSkipReason ||
          (skipped ? "TagMemo+ readout was partially skipped" : null),
      },
    };
  }

  /**
   * RAGDiaryPlugin / LightMemo surface: RiverMemo Topology V3 compatibility
   * adapter. The native stage owns the Rust/Vexus boundary; unsupported
   * stores return the original pool with a reason.
   * @param {object} query - { text, vector }
   * @param {Array<object>} candidates
   * @param {object} [options]
   * @returns {Promise<{results:Array<object>, meta:object|null}>}
   */
  async rerankWithRiverMemoAsync(
    query: UnknownRecord,
    candidates: readonly SearchResult[],
    _options: UnknownRecord = {},
    _meta: UnknownRecord = {},
  ): Promise<{ results: SearchResult[]; meta: UnknownRecord | null }> {
    const source = Array.isArray(candidates) ? candidates : [];
    if (source.length === 0) return { results: [], meta: null };
    const normalized = normalizeCompatCandidates(source);
    const options = {
      ...(isRecord(_options) ? _options : {}),
      ...(isRecord(_meta) ? _meta : {}),
    };
    const ctx = this._compatContext({
      nativeMemoEnabled: true,
      tagMemoV9Enabled: true,
      tagMemoV10Enabled: true,
      topologyV3Enabled: true,
    });
    const input = compatQueryInput(query, normalized, options);
    let output =
      input.nativeMemoSkipped === false
        ? input
        : await new NativeMemoRuntimeStage().process(input, ctx);
    output = await new TopologyV3Stage().process(output, ctx);
    const reranked = Array.isArray(output.mergedCandidates)
      ? (output.mergedCandidates as SearchResult[])
      : source;
    const available = output.topologyV3Skipped !== true;
    return {
      results: reranked,
      meta: {
        strategy: "topology",
        available,
        topologyVersion: output.riverMemo?.version || null,
        native: output.nativeMemoSkipped === false,
        reason:
          output.topologyV3SkipReason ||
          output.nativeMemoSkipReason ||
          (available ? null : "Topology V3 readout was skipped"),
      },
    };
  }

  /**
   * RAGDiaryPlugin surface: diary date index (synchronous, KBM contract).
   * Mirrors diaryMetadataCache.getDateIndex: entries expose
   * `{ relativePath, date (ISO string), diaryDate (Date) }`, newest first.
   * @param {string} diaryName
   * @returns {Array<{relativePath:string, date:string, diaryDate:Date|null}>}
   */
  getDiaryDateIndex(diaryName: string): DateIndexEntry[] {
    const db = this.db;
    if (!db || typeof db.prepare !== "function" || !diaryName) return [];

    let rows: Array<{
      path: string;
      updated_at?: number | null;
      mtime?: number | null;
    }> = [];
    try {
      const statement = db.prepare(
        "SELECT path, updated_at, mtime FROM files WHERE diary_name = ?",
      );
      if (typeof statement.all !== "function") return [];
      rows = statement.all(String(diaryName)) as Array<{
        path: string;
        updated_at?: number | null;
        mtime?: number | null;
      }>;
    } catch (e) {
      return [];
    }

    return rows
      .map((row): DateIndexEntry => {
        const time = Number(row.updated_at) || Number(row.mtime) || 0;
        const date = time > 0 ? new Date(time * 1000) : null;
        return {
          relativePath: String(row.path || ""),
          date: date ? date.toISOString() : null,
          diaryDate: date,
        };
      })
      .filter((meta) => meta.relativePath && meta.date)
      .sort(
        (a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime(),
      );
  }

  /**
   * Embed a diary name for diary-vs-query similarity.
   * @param {string} diaryName
   * @returns {Promise<Float32Array|null>}
   */
  async getDiaryNameVector(diaryName: string): Promise<Float32Array | null> {
    return this._embedText(String(diaryName || ""));
  }

  /**
   * Embed arbitrary text (RAGDiaryPlugin / MetaThinkingManager surface).
   * @param {string|null} diaryName - unused (kept for KBM signature parity)
   * @param {string} text
   * @returns {Promise<Float32Array|null>}
   */
  async getVectorByText(
    _diaryName: string | null,
    text: string,
  ): Promise<Float32Array | null> {
    return this._embedText(String(text || ""));
  }

  /**
   * Float32Array-normalized single-text embedding through the engine
   * provider. Returns null when the provider is missing or the call fails.
   * @param {string} text
   * @returns {Promise<Float32Array|null>}
   * @private
   */
  async _embedText(text: string): Promise<Float32Array | null> {
    if (!text.trim()) return null;
    const provider = this.engine && this.engine.embeddingProvider;
    if (!provider || typeof provider.embedBatch !== "function") return null;
    try {
      const vectors = await provider.embedBatch([text]);
      const vector = vectors && vectors[0];
      if (vector == null) return null;
      return vector instanceof Float32Array ? vector : new Float32Array(vector);
    } catch (e) {
      return null;
    }
  }

  /**
   * RAGDiaryPlugin surface: read a chunk's stored vector by id.
   * @param {number|string} chunkId
   * @returns {Promise<Float32Array|null>}
   */
  async getVectorByChunkId(chunkId: number | string): Promise<Float32Array | null> {
    const db = this.db;
    if (!db || typeof db.prepare !== "function") return null;
    const id = Number(chunkId);
    if (!Number.isFinite(id) || id <= 0) return null;
    try {
      const row = db.prepare("SELECT vector FROM chunks WHERE id = ?").get(id) as
        { vector?: Buffer | Float32Array | null } | undefined;
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
  _decodeChunkVector(blob: Buffer | Float32Array): Float32Array | null {
    const dimension =
      Number(this.engine && this.engine.config && this.engine.config.dimension) || 0;
    if (dimension <= 0) return null;
    return decodeVectorBlob(blob, dimension, "chunk", {
      logPrefix: "KnowledgeBaseAdapter",
    });
  }

  /**
   * RAGDiaryPlugin surface: hydrated chunk rows for a set of file paths.
   * Each row carries `chunkId`, `text`, `fullPath`, `sourceFile`,
   * `fileId`, `diaryName` and the decoded `vector` (Float32Array|null).
   * @param {Array<string>} filePaths
   * @returns {Promise<Array<object>>}
   */
  async getChunksByFilePaths(filePaths: readonly string[]): Promise<CompatChunk[]> {
    const db = this.db;
    if (!db || typeof db.prepare !== "function" || !Array.isArray(filePaths)) {
      return [];
    }
    const unique = [...new Set(filePaths.filter(Boolean))];
    if (unique.length === 0) return [];

    const rows: ChunkQueryRow[] = [];
    for (let i = 0; i < unique.length; i += 500) {
      const batch = unique.slice(i, i + 500);
      const placeholders = batch.map(() => "?").join(",");
      try {
        const statement = db.prepare(`
          SELECT c.id AS chunk_id, c.chunk_index, c.content, c.vector,
                 f.id AS file_id, f.path AS full_path, f.diary_name,
                 f.updated_at, f.mtime
          FROM files f
          JOIN chunks c ON c.file_id = f.id
          WHERE f.path IN (${placeholders})
          ORDER BY c.chunk_index
        `);
        if (typeof statement.all === "function") {
          rows.push(...(statement.all(...batch) as ChunkQueryRow[]));
        }
      } catch (e) {
        continue;
      }
    }

    return rows.map((row) => ({
      chunkId: Number(row.chunk_id),
      chunkIndex: Number(row.chunk_index),
      text: row.content,
      content: row.content,
      fileId: Number(row.file_id),
      fullPath: String(row.full_path || ""),
      sourceFile: String(row.full_path || "")
        ? path.basename(String(row.full_path))
        : "",
      diaryName: String(row.diary_name || ""),
      updatedAt: row.updated_at != null ? Number(row.updated_at) : null,
      mtime: row.mtime != null ? Number(row.mtime) : null,
      vector: row.vector != null ? this._decodeChunkVector(row.vector) : null,
    }));
  }
}

export default KnowledgeBaseAdapter;
