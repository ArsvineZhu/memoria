"use strict";

import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";

import PipelineContext from "../core/context.js";
import TDBStore from "./tdb-store.js";
import TDBSearchPipeline from "./tdb-search-pipeline.js";
import VexusVectorStore from "../providers/vexus-vector-store.js";
import OpenAIEmbeddingProvider from "../providers/openai-embedding-provider.js";
import { chunkText } from "../utils/text-chunker.js";
import { mergeConfig } from "../config/default-config.js";
import { at } from "../utils/numerical.js";
import type {
  EmbeddingProviderContract,
  MemoryConfig,
  TdbChunkInput,
  TdbDeleteEnvelope,
  TdbEngineOptions,
  TdbIngestEnvelope,
  TdbSearchEnvelope,
  TdbSearchOptions,
  TdbStats,
  TdbSearchResult,
  TdbStoreContract,
  TriviumDBContract,
  TriviumSearchHit,
  VectorLike,
  VectorStoreContract,
} from "../types.js";

function safeLibraryName(name: unknown): string {
  return (
    String(name || "Root")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .trim() || "Root"
  );
}

/**
 * Resolve the library name for an absolute path under the TDB root.
 * Mirrors TDBKnowledgeManager._resolveLibrary: the first path segment
 * under the root names the library, everything else lives in "Root".
 * @param {string} rootPath
 * @param {string} absPath
 * @returns {{library:string, relPath:string}}
 * @private
 */
function resolveLibrary(
  rootPath: string,
  absPath: string,
): { library: string; relPath: string } {
  const relPath = path.relative(rootPath, absPath);
  const parts = relPath.split(path.sep).filter(Boolean);
  return {
    library: safeLibraryName(parts.length > 1 ? parts[0] : "Root"),
    relPath,
  };
}

/**
 * TDBEngine — cold-knowledge (TriviumDB) engine.
 *
 * A standalone port of the TDBKnowledge.js manager core (the "Trivial
 * Database" cold-knowledge layer for large, low-variation knowledge sets):
 * per-library hybrid vector + keyword indexing with reliable metadata
 * persistence. The watcher/queue/evictor machinery of the original is
 * intentionally left out — ingestion is pulled (upsertText / upsertFile)
 * instead of file-system-event driven.
 *
 * All I/O is injectable:
 *   - metadataStore  TDBStore (or any MetadataStore-compatible layer)
 *   - vectorStore    VectorStore-compatible store (per-library indices)
 *   - embeddingProvider — EmbeddingProvider-compatible embedder
 *
 * When `trivium` is injected (a TriviumDBAdapter), search calls route
 * through its native-style `search` / `searchHybrid`/`delete` surface,
 * mirroring the original's optional-native-module behavior; otherwise the
 * local hybrid pipeline is used.
 */
class TDBEngine {
  name: string;
  options: TdbEngineOptions;
  config: MemoryConfig;
  enabled: boolean;
  metadataStore: TdbStoreContract;
  vectorStore: VectorStoreContract;
  embeddingProvider: EmbeddingProviderContract;
  trivium: TriviumDBContract | null;
  ctx: PipelineContext;
  searchPipeline: TDBSearchPipeline;
  initialized: boolean;
  _closed: boolean;
  /**
   * @param {object} [options={}]
   * @param {object} [options.config]            - merged over DEFAULT_CONFIG
   * @param {import('./tdb-store.js')} [options.metadataStore]
   * @param {import('../interfaces/vector-store.js')} [options.vectorStore]
   * @param {import('../interfaces/embedding-provider.js')} [options.embeddingProvider]
   * @param {import('./triviumdb-adapter.js')} [options.trivium] - optional native adapter
   * @param {object} [options.searchOptions]   - forwarded to TDBSearchPipeline
   */
  constructor(options: TdbEngineOptions = {}) {
    this.name = "tdbEngine";
    this.options = options || {};
    this.config = mergeConfig(this.options.config);
    this.enabled = this.config.tdbEnabled === true;

    // Providers — injected instances win; disabled engines defer creation
    // so no store files are produced until initialize() succeeds.
    this.metadataStore = (this.options.metadataStore ||
      (this.enabled
        ? new TDBStore({
            dbPath: this.config.tdbDbPath,
            busyTimeout: this.config.busyTimeout,
          })
        : null)) as unknown as TdbStoreContract;
    this.vectorStore = (this.options.vectorStore ||
      (this.enabled
        ? new VexusVectorStore({
            dimension: Number(this.config.tdbDimension) || this.config.dimension,
            storePath: this.config.tdbStorePath,
            tagIndexCapacity: this.config.tagIndexCapacity,
            indexSaveDelay: this.config.indexSaveDelay,
          })
        : null)) as unknown as VectorStoreContract;
    this.embeddingProvider = (this.options.embeddingProvider ||
      (this.enabled
        ? new OpenAIEmbeddingProvider({
            apiUrl: this.config.apiUrl,
            apiKey: this.config.apiKey,
            model: this.config.tdbModel || this.config.model,
            dimension: Number(this.config.tdbDimension) || this.config.dimension,
            maxBatchItems: this.config.maxBatchItems,
            maxToken: this.config.maxToken,
            concurrency: this.config.concurrency,
            fallbackModels: this.config.fallbackModels,
          })
        : null)) as unknown as EmbeddingProviderContract;
    this.trivium = this.options.trivium || null;

    this.ctx = new PipelineContext({
      config: this.config,
      embeddingProvider: this.embeddingProvider,
      vectorStore: this.vectorStore,
      metadataStore: this
        .metadataStore as unknown as import("../types.js").MetadataStoreContract,
    });
    this.searchPipeline = new TDBSearchPipeline(
      this.config,
      this.options.searchOptions || {},
    );

    this.initialized = false;
    this._closed = false;
  }

  /**
   * Open the engine: prepare the store dirs and relax the persisted vector
   * indices of each known library. No-op (returns false) when disabled or
   * already initialized.
   * @returns {Promise<boolean>}
   */
  async initialize() {
    if (this.initialized) return true;
    if (!this.enabled) return false;

    try {
      fs.mkdirSync(this.config.tdbRootPath, { recursive: true });
    } catch (_) {
      /* root path is best-effort */
    }
    try {
      fs.mkdirSync(this.config.tdbStorePath, { recursive: true });
    } catch (_) {
      /* store path is best-effort */
    }

    let libraries: string[] = [];
    if (typeof this.metadataStore.listLibraries === "function") {
      try {
        libraries = await this.metadataStore.listLibraries();
      } catch (_) {
        libraries = [];
      }
    }
    for (const name of libraries) {
      await this._openIndex(name);
    }

    this.initialized = true;
    return true;
  }

  async _openIndex(library: string): Promise<void> {
    const safeName = safeLibraryName(library);
    if (!this.vectorStore || typeof this.vectorStore.loadIndex !== "function") return;
    try {
      await this.vectorStore.loadIndex(safeName, "");
    } catch (_) {
      // No persisted index yet — first write creates it.
    }
  }

  async _saveIndex(library: string): Promise<void> {
    if (!this.vectorStore) return;
    if (typeof this.vectorStore.scheduleIndexSave === "function") {
      try {
        this.vectorStore.scheduleIndexSave(safeLibraryName(library));
        return;
      } catch (_) {
        /* fall through to direct save */
      }
    }
    if (typeof this.vectorStore.saveIndex === "function") {
      try {
        await this.vectorStore.saveIndex(safeLibraryName(library), "");
      } catch (_) {
        /* in-memory store — nothing to persist */
      }
    }
  }

  // ── Ingestion ───────────────────────────────────────────────────

  /**
   * Library name for a relPath, mirroring TDBKnowledge._resolveLibrary:
   * the first directory segment names the library; single-segment (plain
   * file) paths live in "Root".
   * @param {string} relPath
   * @returns {string}
   * @private
   */
  _libraryFromRelPath(relPath: string): string {
    const parts = String(relPath || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean);
    return parts.length > 1 ? at(parts, 0, "library path") : "Root";
  }

  /**
   * Ingest a plain-text document. Checksum dedupe skips unchanged
   * re-ingestion; changed content replaces the previous chunks (mirror of
   * TDBKnowledge's upsert flow, without the file watcher).
   * @param {string} text
   * @param {object} [options={}]
   * @param {string} [options.library]  - library name (default from path / 'Root')
   * @param {string} [options.path]     - relPath within the library
   * @param {string} [options.title]    - display title (default path basename)
   * @param {number} [options.now]      - epoch-seconds clock override
   * @param {number} [options.mtime]
   * @param {number} [options.size]
   * @returns {Promise<object>} ingest envelope
   */
  async upsertText(
    text: string,
    options: TdbSearchOptions = {},
  ): Promise<TdbIngestEnvelope> {
    if (!this.initialized || !this.enabled) return { skipped: true, disabled: true };
    const content = String(text || "");
    if (!content.trim()) return { skipped: true, reason: "empty" };

    const now = Number.isFinite(Number(options.now))
      ? Math.floor(Number(options.now))
      : Math.floor(Date.now() / 1000);
    const relPath = String(options.path || "");
    const library = safeLibraryName(
      options.library || this._libraryFromRelPath(relPath),
    );
    const checksum = crypto.createHash("sha256").update(content).digest("hex");
    const size =
      options.size != null ? Number(options.size) : Buffer.byteLength(content, "utf-8");
    const mtime = options.mtime != null ? Number(options.mtime) : now * 1000;

    // Content dedupe (checksum + size), mirroring the original which
    // reuses previous embeddings when the file content is unchanged.
    const existing = await this.metadataStore.getFile(library, relPath);
    if (existing && existing.checksum === checksum && Number(existing.size) === size) {
      if (Number(existing.mtime) !== mtime) {
        await this.metadataStore.upsertFile({
          library,
          path: relPath,
          checksum,
          mtime,
          size,
          updatedAt: now,
        });
      }
      return { skipped: true, library, path: relPath, fileId: existing.id, checksum };
    }

    const chunks = chunkText(content, {
      maxTokens: Number(this.config.chunkMaxTokens) || 600,
      overlapTokens:
        Number(this.config.chunkOverlapTokens) ||
        Math.floor((Number(this.config.chunkMaxTokens) || 600) * 0.16),
    }).filter(Boolean);
    if (chunks.length === 0) {
      return { skipped: true, reason: "no-chunks", checksum };
    }

    // 1. Embed chunk text (batched, mirroring TDBKnowledge embedding loop).
    const vectors: Array<number[] | null> = [];
    const maxBatch = Math.max(1, Number(this.config.tdbEmbeddingBatchSize) || 16);
    for (let start = 0; start < chunks.length; start += maxBatch) {
      const batch = chunks.slice(start, start + maxBatch);
      let batchVectors: Array<import("../types.js").EmbeddingVector | null> = [];
      try {
        batchVectors = await this.embeddingProvider.embedBatch(batch);
      } catch (e) {
        console.warn(
          `[TDBEngine] embedding failed for ${relPath}: ${e instanceof Error ? e.message : String(e)}`,
        );
        batchVectors = [];
      }
      for (const v of batchVectors) {
        vectors.push(v == null ? null : Array.from(v));
      }
    }

    // 2. Persist chunk rows (only successfully embedded chunks).
    const rows: Array<{ chunkId: number; nodeId: number; text: string }> = [];
    const chunkRows: TdbChunkInput[] = [];
    for (let index = 0; index < chunks.length; index++) {
      const vector = at(vectors, index, "TDB embeddings");
      if (vector == null) continue;
      const chunk = at(chunks, index, "TDB chunks");
      const chunkChecksum = crypto.createHash("sha256").update(chunk).digest("hex");
      chunkRows.push({ text: chunk, checksum: chunkChecksum });
    }
    const inserted = await this.metadataStore.insertChunks(library, relPath, chunkRows);

    // 3. Index vectors under the library index (node id == chunk row id).
    let vectorOffset = 0;
    for (let index = 0; index < chunks.length; index++) {
      const vector = at(vectors, index, "TDB embeddings");
      if (vector == null) continue;
      const row = inserted[vectorOffset++];
      if (!row) continue;
      try {
        await this.vectorStore.add(library, row.nodeId, new Float32Array(vector));
      } catch (e) {
        console.warn(
          `[TDBEngine] vector add failed for ${relPath}#${index}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      rows.push({
        chunkId: row.chunkId,
        nodeId: row.nodeId,
        text: at(chunks, index, "TDB chunks"),
      });
    }

    // 4. Persist the file header.
    const fileId = await this.metadataStore.upsertFile({
      library,
      path: relPath,
      checksum,
      mtime,
      size,
      updatedAt: now,
    });

    await this._saveIndex(library);

    return {
      skipped: false,
      library,
      path: relPath,
      fileId,
      checksum,
      chunkCount: rows.length,
      fileSize: size,
      nodeIds: rows.map((r) => r.nodeId),
    };
  }

  /**
   * Ingest a file from the TDB root (or an absolute path).
   * @param {string} filePath
   * @param {object} [options={}] - forwarded to upsertText (+ library override)
   * @returns {Promise<object>}
   */
  async upsertFile(
    filePath: string,
    options: TdbSearchOptions = {},
  ): Promise<TdbIngestEnvelope> {
    if (!this.initialized || !this.enabled) return { skipped: true, disabled: true };
    const absPath = path.resolve(filePath);
    let content: string;
    let stats: fs.Stats;
    try {
      stats = fs.statSync(absPath);
      content = fs.readFileSync(absPath, "utf-8");
    } catch (e) {
      console.warn(
        `[TDBEngine] read failed for "${filePath}": ${e instanceof Error ? e.message : String(e)}`,
      );
      return { skipped: true, reason: "unreadable" };
    }
    const resolved = resolveLibrary(this.config.tdbRootPath, absPath);
    return this.upsertText(content, {
      path: options.path || resolved.relPath,
      library: options.library || resolved.library,
      title: options.title || path.basename(absPath),
      mtime: options.mtime != null ? options.mtime : stats.mtimeMs,
      size: options.size != null ? options.size : stats.size,
      now: options.now,
    });
  }

  /**
   * Remove a file (and its chunks + vectors) by (library, path).
   * @param {{library:string, path:string}|string} input
   * @returns {Promise<object>}
   */
  async removeFile(
    input: string | { library?: string; path?: string },
  ): Promise<TdbDeleteEnvelope> {
    if (!this.initialized || !this.enabled) return { removed: false, disabled: true };
    const source = typeof input === "string" ? { path: input } : input || {};
    const relPath = String(source.path || "");
    const library = safeLibraryName(
      source.library || this._libraryFromRelPath(relPath),
    );

    const file = await this.metadataStore.getFile(library, relPath);
    if (!file) return { removed: false, library, path: relPath };

    const { chunkIds, nodeIds } = await this.metadataStore.deleteFile(library, relPath);
    for (const nodeId of nodeIds) {
      try {
        await this.vectorStore.remove(library, nodeId);
      } catch (e) {
        console.warn(
          `[TDBEngine] vector remove failed for node ${nodeId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    await this._saveIndex(library);
    return {
      removed: true,
      library,
      path: relPath,
      fileId: file.id,
      removedChunkIds: chunkIds,
    };
  }

  /**
   * Alias of removeFile({ library, path }).
   */
  async removeText(
    options: string | { library?: string; path?: string },
  ): Promise<TdbDeleteEnvelope> {
    return this.removeFile(options);
  }

  // ── Search ──────────────────────────────────────────────────────

  /**
   * Hybrid cold-knowledge search.
   * @param {string} queryText
   * @param {object} [options={}] - { libraries, topK, minScore, hybridAlpha,
   *                                expand, expandDepth }
   * @returns {Promise<object>} envelope { results, resultCount, ... }
   */
  async search(
    queryText: string,
    options: TdbSearchOptions = {},
  ): Promise<TdbSearchEnvelope> {
    if (!this.initialized || !this.enabled) {
      return { results: [], resultCount: 0, tdbDisabled: true };
    }
    const safeQueryText = String(queryText || "");
    let out: TdbSearchEnvelope;
    if (this.trivium) {
      const [queryVector] = safeQueryText
        ? await this.embeddingProvider.embedBatch([safeQueryText])
        : [null];
      if (!queryVector) return { results: [], resultCount: 0 };
      out = await this._searchViaTrivium(queryVector, safeQueryText, options);
    } else {
      out = (await this.searchPipeline.run(
        { query: safeQueryText, options },
        this.ctx,
      )) as TdbSearchEnvelope;
    }
    if (options.expand && Array.isArray(out.results)) {
      out.results = await this._expandHits(out.results);
    }
    return out;
  } /**
   * Search reusing an already-computed query vector (avoids re-embedding).
   * @param {Float32Array|number[]} queryVector
   * @param {string} queryText
   * @param {object} [options={}]
   * @returns {Promise<object>}
   */
  async searchWithVector(
    queryVector: VectorLike,
    queryText: string,
    options: TdbSearchOptions = {},
  ): Promise<TdbSearchEnvelope> {
    if (!this.initialized || !this.enabled || !queryVector) {
      return { results: [], resultCount: 0, tdbDisabled: true };
    }
    const out = this.trivium
      ? await this._searchViaTrivium(queryVector, queryText, options)
      : ((await this.searchPipeline.run(
          { query: queryText, vector: queryVector, options },
          this.ctx,
        )) as TdbSearchEnvelope);
    if (options.expand && Array.isArray(out.results)) {
      out.results = await this._expandHits(out.results);
    }
    return out;
  }

  /**
   * Adapter-backed search mirroring TDBKnowledge._searchLibraryUnlocked:
   * when a TriviumDBAdapter is injected, per-library searchHybrid →
   * search fallback is used instead of the local hybrid pipeline.
   * @private
   */
  async _searchViaTrivium(
    queryVector: VectorLike,
    queryText: string,
    options: TdbSearchOptions = {},
  ): Promise<TdbSearchEnvelope> {
    const trivium = this.trivium;
    if (!trivium) return { results: [], resultCount: 0 };
    const safeQueryText = typeof queryText === "string" ? queryText : "";
    const topK = Math.max(1, Math.round(Number(options.topK) || 10));
    const expandDepth = Number.isFinite(Number(options.expandDepth))
      ? Number(options.expandDepth)
      : 1;
    const minScore = Number.isFinite(Number(options.minScore))
      ? Number(options.minScore)
      : 0.1;
    const hybridAlpha = Number.isFinite(Number(options.hybridAlpha))
      ? Number(options.hybridAlpha)
      : Number(this.config.tdbHybridAlpha) || 0.7;

    const libraries =
      Array.isArray(options.libraries) && options.libraries.length > 0
        ? options.libraries.map(safeLibraryName)
        : await this.listLibraries();
    if (libraries.length === 0) {
      return { results: [], resultCount: 0 };
    }

    const results: TdbSearchResult[] = [];
    for (const library of libraries) {
      let hits: TriviumSearchHit[] | null = null;
      if (typeof trivium.searchHybrid === "function") {
        try {
          hits = await trivium.searchHybrid(
            queryVector,
            safeQueryText,
            topK,
            expandDepth,
            minScore,
            hybridAlpha,
            { index: library },
          );
        } catch (_) {
          hits = null;
        }
      }
      if (hits == null && typeof trivium.search === "function") {
        try {
          hits = await trivium.search(queryVector, topK, { index: library });
        } catch (_) {
          hits = [];
        }
      }
      for (const hit of hits || []) {
        const chunk = await this.metadataStore.getChunkById(hit.id);
        const payloadText =
          hit.payload && typeof hit.payload.text === "string" ? hit.payload.text : "";
        results.push({
          library: String(library),
          id: hit.id,
          score: Number(hit.score) || 0,
          payload: hit.payload || {},
          text: chunk?.text ?? payloadText,
          path: chunk?.path ?? "",
          sourceFile: chunk ? chunk.path : "",
          chunkIndex: chunk ? chunk.chunkIndex : undefined,
        });
      }
    }

    results.sort((a, b) => (b.score || 0) - (a.score || 0));
    const top = results.slice(0, topK);
    return { results: top, resultCount: top.length };
  }

  /**
   * Parent-document expansion: replace each hit's text with the full
   * source file content (per-file dedupe, highest score wins). Mirrors
   * TDBKnowledge._expandHits; unreadable files fall back to the hit.
   * @param {Array<object>} hits
   * @returns {Promise<Array<object>>}
   */
  async _expandHits(hits: readonly TdbSearchResult[]): Promise<TdbSearchResult[]> {
    const seenFiles = new Set<string>();
    const out: TdbSearchResult[] = [];
    for (const hit of hits) {
      const relPath = hit.path || hit.sourceFile;
      if (!relPath || seenFiles.has(relPath)) {
        out.push(hit);
        continue;
      }
      seenFiles.add(relPath);
      try {
        const abs = path.join(this.config.tdbRootPath, relPath);
        const full = fs.readFileSync(abs, "utf-8");
        out.push({ ...hit, text: full, _expanded: true });
      } catch (e) {
        console.warn(
          `[TDBEngine] expand failed for "${relPath}": ${e instanceof Error ? e.message : String(e)}`,
        );
        out.push(hit);
      }
    }
    return out;
  }

  // ── Introspection ───────────────────────────────────────────────

  /**
   * @returns {Promise<string[]>}
   */
  async listLibraries(): Promise<string[]> {
    if (typeof this.metadataStore.listLibraries === "function") {
      const names = await this.metadataStore.listLibraries();
      return Array.isArray(names) ? names : [];
    }
    return [];
  }

  /**
   * Cold-knowledge stats.
   * @returns {Promise<object>}
   */
  async getStats(): Promise<TdbStats> {
    const all =
      typeof this.metadataStore.getAllChunks === "function"
        ? await this.metadataStore.getAllChunks()
        : [];
    let fileCount = 0;
    if (this.metadataStore.db && typeof this.metadataStore.db.prepare === "function") {
      try {
        const row = this.metadataStore.db
          .prepare("SELECT COUNT(*) AS c FROM files")
          .get() as { c?: number } | undefined;
        fileCount = Number(row && row.c) || 0;
      } catch (_) {
        /* fall through */
      }
    }
    return {
      enabled: this.enabled,
      initialized: this.initialized,
      files: fileCount,
      chunks: Array.isArray(all) ? all.length : 0,
      libraries: await this.listLibraries(),
      storePath: this.config.tdbStorePath,
      rootPath: this.config.tdbRootPath,
    };
  }

  /**
   * Shut the engine down: flush pending index saves and close the store.
   * Idempotent.
   * @returns {Promise<void>}
   */
  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this.vectorStore && typeof this.vectorStore.flushPendingSaves === "function") {
      try {
        await this.vectorStore.flushPendingSaves();
      } catch (e) {
        console.error(
          `[TDBEngine] flush pending saves failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (this.metadataStore && typeof this.metadataStore.close === "function") {
      this.metadataStore.close();
    }
  }
}

export { TDBEngine, resolveLibrary, safeLibraryName };
