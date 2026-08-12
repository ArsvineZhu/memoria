"use strict";

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import type { TdbGenerationState, TdbStoreContract } from "../types/tdb.js";
import type { HealthStatus } from "../types/metadata.js";
import { initializeTdbSchema, TdbGenerationStore } from "./tdb-schema.js";
import { TdbDocumentRepository } from "./tdb-document-repository.js";
import { TdbQueryRepository } from "./tdb-query-repository.js";

/**
 * TDBStore — dedicated SQLite metadata layer for the TDB (TriviumDB
 * cold-knowledge) engine.
 *
 * Mirrors the legacy TDB table shape used by VectorStoreTDB. Per-library
 * `files` rows carry document checksum / sourceUpdatedAt / recordedAt / indexedAt bookkeeping while
 * `chunks` map chunk_index →
 * vector node id. One local deviation: the `chunks.text` column stores the
 * chunk text itself, replacing the original TriviumDB native payload, since
 * this library has no native text index (the BM25 stage reads it).
 *
 * All methods are async to match the MetadataStore conventions, though the
 * underlying better-sqlite3 calls are synchronous.
 */

const requireFromStore = createRequire(import.meta.url);
let DatabaseCtor: typeof BetterSqlite3 | null = null;

function loadDatabaseCtor(): typeof BetterSqlite3 | null {
  if (DatabaseCtor) return DatabaseCtor;
  try {
    const loaded = requireFromStore("better-sqlite3") as
      typeof BetterSqlite3 | { default?: typeof BetterSqlite3 };
    DatabaseCtor = typeof loaded === "function" ? loaded : (loaded.default ?? null);
  } catch {
    DatabaseCtor = null;
  }
  return DatabaseCtor;
}

interface TdbStoreConfig {
  dbPath?: string;
  busyTimeout?: number;
}

class TDBStore implements TdbStoreContract {
  dbPath: string;
  busyTimeout: number;
  _closed: boolean;
  /** @internal */
  db: BetterSqlite3.Database;
  private readonly generations: TdbGenerationStore;
  private readonly documents: TdbDocumentRepository;
  private readonly queries: TdbQueryRepository;
  upsertFile!: TdbStoreContract["upsertFile"];
  replaceDocumentState!: TdbStoreContract["replaceDocumentState"];
  deleteDocumentState!: TdbStoreContract["deleteDocumentState"];
  getFile!: TdbStoreContract["getFile"];
  getFileById!: TdbStoreContract["getFileById"];
  getFileByChunkId!: TdbStoreContract["getFileByChunkId"];
  deleteFile!: TdbStoreContract["deleteFile"];
  insertChunks!: TdbStoreContract["insertChunks"];
  getChunks!: TdbStoreContract["getChunks"];
  getChunkById!: TdbStoreContract["getChunkById"];
  getAllChunks!: TdbStoreContract["getAllChunks"];
  getSearchCorpus!: TdbStoreContract["getSearchCorpus"];
  listLibraries!: TdbStoreContract["listLibraries"];
  getDistinctSpaces!: TdbStoreContract["getDistinctSpaces"];
  getExpectedVectorIndexNames!: TdbStoreContract["getExpectedVectorIndexNames"];
  getTdbRebuildChunks!: TdbStoreContract["getTdbRebuildChunks"];
  updateChunkVectors!: TdbStoreContract["updateChunkVectors"];
  countFiles!: TdbStoreContract["countFiles"];
  /**
   * @param {object} config
   * @param {string} [config.dbPath]        - SQLite file path (or ':memory:')
   * @param {number} [config.busyTimeout]   - SQLite busy_timeout in ms (default 10000)
   */
  constructor(config: TdbStoreConfig = {}) {
    const Database = loadDatabaseCtor();
    if (!Database) {
      throw new Error(
        "better-sqlite3 is not available. Install it with: pnpm add better-sqlite3",
      );
    }
    this.dbPath = config.dbPath || ":memory:";
    this.busyTimeout = config.busyTimeout || 10000;
    this._closed = false;

    if (this.dbPath !== ":memory:" && !this.dbPath.startsWith("file:")) {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    }
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma(`busy_timeout = ${this.busyTimeout}`);
    initializeTdbSchema(this.db);
    this.generations = new TdbGenerationStore(this.db);
    this.documents = new TdbDocumentRepository(this.db, this.generations);
    this.queries = new TdbQueryRepository(this.db);
    this.upsertFile = this.documents.upsertFile.bind(this.documents);
    this.replaceDocumentState = this.documents.replaceDocumentState.bind(
      this.documents,
    );
    this.deleteDocumentState = this.documents.deleteDocumentState.bind(this.documents);
    this.getFile = this.queries.getFile.bind(this.queries);
    this.getFileById = this.queries.getFileById.bind(this.queries);
    this.getFileByChunkId = this.queries.getFileByChunkId.bind(this.queries);
    this.deleteFile = this.documents.deleteFile.bind(this.documents);
    this.insertChunks = this.documents.insertChunks.bind(this.documents);
    this.getChunks = this.queries.getChunks.bind(this.queries);
    this.getChunkById = this.queries.getChunkById.bind(this.queries);
    this.getAllChunks = this.queries.getAllChunks.bind(this.queries);
    this.getSearchCorpus = this.queries.getSearchCorpus.bind(this.queries);
    this.listLibraries = this.queries.listLibraries.bind(this.queries);
    this.getDistinctSpaces = this.queries.getDistinctSpaces.bind(this.queries);
    this.getExpectedVectorIndexNames = this.queries.getExpectedVectorIndexNames.bind(
      this.queries,
    );
    this.getTdbRebuildChunks = this.queries.getTdbRebuildChunks.bind(this.queries);
    this.updateChunkVectors = this.documents.updateChunkVectors.bind(this.documents);
    this.countFiles = this.queries.countFiles.bind(this.queries);
  }

  // ── Files ────────────────────────────────────────────────────────

  /**
   * Insert or update a file row (UNIQUE(library, path)).
   * @param {{library:string, path:string, checksum:string, sourceUpdatedAt:number,
   *          size:number, docNodeId?:number, recordedAt?:number, indexedAt?:number}} meta
   * @returns {Promise<number>} file id
   */
  /**
   * @param {string} library
   * @param {string} path
   * @returns {Promise<object|null>}
   */
  /**
   * @param {number} id
   * @returns {Promise<object|null>}
   */
  /**
   * File row owning a chunk (node_id lookup) — reverse resolution used by
   * the fusion / decay stages.
   * @param {number} chunkId
   * @returns {Promise<object|null>}
   */
  /**
   * Remove a file and its chunk rows.
   * @param {string} library
   * @param {string} path
   * @returns {Promise<{chunkIds:number[], nodeIds:number[]}>}
   */
  // ── Chunks ───────────────────────────────────────────────────────

  /**
   * Insert chunk rows for a file, replacing previous rows for the path.
   * `node_id` is the chunk row id itself (the vector index shares the id
   * space with the chunk table).
   * @param {string} library
   * @param {string} path
   * @param {Array<{text:string, checksum:string}>} chunks
   * @returns {Promise<Array<{chunkId:number, nodeId:number}>>}
   */
  // ── Libraries ────────────────────────────────────────────────────

  /**
   * gated-over/blob name for the generic VectorSearcherStage.
   * @returns {Promise<string[]>}
   */
  // ── KV ───────────────────────────────────────────────────────────

  async getMeta(key: string): Promise<string | null> {
    return this.generations.get(key);
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.generations.setInTransaction(key, String(value));
  }

  async getTdbGenerationState(): Promise<TdbGenerationState> {
    return this.generations.getState();
  }

  async markTdbVectorStateClean(): Promise<void> {
    this.generations.markClean();
  }

  // ── Health / lifecycle ───────────────────────────────────────────

  async healthCheck(): Promise<HealthStatus> {
    const issues: string[] = [];
    try {
      this.db.prepare("SELECT 1").get();
    } catch (e) {
      issues.push(e instanceof Error ? e.message : String(e));
    }
    return { healthy: issues.length === 0, issues };
  }

  close() {
    if (this._closed) return;
    this.db.close();
    this._closed = true;
  }
}

export default TDBStore;
