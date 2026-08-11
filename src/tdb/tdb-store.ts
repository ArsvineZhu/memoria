"use strict";

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import type {
  HealthStatus,
  TdbChunkInput,
  TdbChunkRow,
  TdbCorpusChunk,
  TdbDeleteDocumentStateResult,
  TdbDocumentStateReplacement,
  TdbDocumentStateReplacementResult,
  TdbFileRow,
  TdbGenerationState,
  TdbInsertedChunk,
  TdbRebuildChunk,
  SearchCorpusChunk,
  TdbStoreContract,
} from "../types.js";

/**
 * TDBStore — dedicated SQLite metadata layer for the TDB (TriviumDB
 * cold-knowledge) engine.
 *
 * Mirrors the legacy TDB table shape used by VectorStoreTDB. Per-library
 * `files` rows carry document checksum / mtime / size bookkeeping while
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

interface TdbFileQueryRow {
  id: number;
  library: string;
  path: string;
  checksum: string;
  mtime: number;
  size: number;
  doc_node_id?: number | null;
  updated_at?: number | null;
}

interface TdbChunkQueryRow {
  id: number;
  library: string;
  path: string;
  chunk_index: number;
  node_id: number;
  text: string;
  checksum: string;
  vector?: Buffer | null;
}

interface TdbMetaRow {
  value?: string | null;
}

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        library TEXT NOT NULL,
        path TEXT NOT NULL,
        checksum TEXT NOT NULL,
        mtime REAL NOT NULL,
        size INTEGER NOT NULL,
        doc_node_id INTEGER,
        updated_at INTEGER NOT NULL,
        UNIQUE(library, path)
    );
    CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        library TEXT NOT NULL,
        path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        node_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        checksum TEXT NOT NULL,
        vector BLOB,
        UNIQUE(library, path, chunk_index)
    );
    CREATE TABLE IF NOT EXISTS tdb_meta (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tdb_files_library ON files(library);
    CREATE INDEX IF NOT EXISTS idx_tdb_chunks_file ON chunks(library, path);
    CREATE INDEX IF NOT EXISTS idx_tdb_chunks_node ON chunks(node_id);
`;

class TDBStore implements TdbStoreContract {
  dbPath: string;
  busyTimeout: number;
  _closed: boolean;
  db: BetterSqlite3.Database;
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
    this.db.exec(SCHEMA_SQL);
    this._migrateSchema();
    this._initializeGenerationKeys();
  }

  private _migrateSchema(): void {
    const columns = this.db.prepare("PRAGMA table_info(chunks)").all() as Array<{
      name?: string;
    }>;
    if (!columns.some((column) => column.name === "vector")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN vector BLOB");
    }
  }

  private _initializeGenerationKeys(): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO tdb_meta (key, value) VALUES (?, ?)",
    );
    this.db.transaction(() => {
      insert.run("tdb.metadata_generation", "0");
      insert.run("tdb.vector_generation", "0");
      insert.run("tdb.vector_dirty", "1");
    })();
  }

  // ── Files ────────────────────────────────────────────────────────

  /**
   * Insert or update a file row (UNIQUE(library, path)).
   * @param {{library:string, path:string, checksum:string, mtime:number,
   *          size:number, docNodeId?:number, updatedAt?:number}} meta
   * @returns {Promise<number>} file id
   */
  async upsertFile(meta: {
    library: string;
    path: string;
    checksum: string;
    mtime: number;
    size: number;
    docNodeId?: number | null;
    updatedAt?: number;
  }): Promise<number | null> {
    const updatedAt = Number.isFinite(Number(meta.updatedAt))
      ? Math.floor(Number(meta.updatedAt))
      : Math.floor(Date.now() / 1000);
    const transaction = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          "SELECT id, checksum, mtime, size, doc_node_id, updated_at FROM files WHERE library = ? AND path = ?",
        )
        .get(meta.library, meta.path) as
        | {
            id: number;
            checksum: string;
            mtime: number;
            size: number;
            doc_node_id?: number | null;
            updated_at?: number | null;
          }
        | undefined;
      const changed =
        !existing ||
        existing.checksum !== meta.checksum ||
        Number(existing.mtime) !== Number(meta.mtime) ||
        Number(existing.size) !== Number(meta.size) ||
        (existing.doc_node_id ?? null) !== (meta.docNodeId ?? null) ||
        Number(existing.updated_at) !== updatedAt;

      this.db
        .prepare(
          `
          INSERT INTO files (library, path, checksum, mtime, size, doc_node_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(library, path) DO UPDATE SET
              checksum = excluded.checksum,
              mtime = excluded.mtime,
              size = excluded.size,
              doc_node_id = excluded.doc_node_id,
              updated_at = excluded.updated_at
      `,
        )
        .run(
          meta.library,
          meta.path,
          meta.checksum,
          meta.mtime,
          meta.size,
          meta.docNodeId ?? null,
          updatedAt,
        );
      const row = this.db
        .prepare("SELECT id FROM files WHERE library = ? AND path = ?")
        .get(meta.library, meta.path) as { id?: number } | undefined;
      if (changed) {
        this._incrementMetadataGeneration();
        this._setMetaInTransaction("tdb.vector_dirty", "1");
      }
      return row?.id ?? null;
    });
    return transaction();
  }

  async replaceDocumentState(
    replacement: TdbDocumentStateReplacement,
  ): Promise<TdbDocumentStateReplacementResult> {
    const { file, chunks } = replacement;
    const transaction = this.db.transaction(() => {
      const oldRows = this.db
        .prepare(
          "SELECT id, node_id FROM chunks WHERE library = ? AND path = ? ORDER BY chunk_index",
        )
        .all(file.library, file.path) as Array<{ id: number; node_id: number }>;

      this.db
        .prepare(
          `
          INSERT INTO files (library, path, checksum, mtime, size, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(library, path) DO UPDATE SET
            checksum = excluded.checksum,
            mtime = excluded.mtime,
            size = excluded.size,
            updated_at = excluded.updated_at
        `,
        )
        .run(
          file.library,
          file.path,
          file.checksum,
          file.mtime,
          file.size,
          file.updatedAt,
        );

      const fileRow = this.db
        .prepare("SELECT id FROM files WHERE library = ? AND path = ?")
        .get(file.library, file.path) as { id?: number } | undefined;
      const fileId = Number(fileRow?.id);
      if (!Number.isSafeInteger(fileId) || fileId <= 0) {
        throw new Error("TDB file upsert did not return an id");
      }

      this.db
        .prepare("DELETE FROM chunks WHERE library = ? AND path = ?")
        .run(file.library, file.path);

      const insertChunk = this.db.prepare(`
        INSERT INTO chunks
          (library, path, chunk_index, node_id, text, checksum, vector)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const updateNodeId = this.db.prepare(
        "UPDATE chunks SET node_id = ? WHERE id = ?",
      );
      const chunkIds: number[] = [];
      const nodeIds: number[] = [];
      chunks.forEach((chunk, index) => {
        const inserted = insertChunk.run(
          file.library,
          file.path,
          index,
          0,
          chunk.text,
          chunk.checksum,
          chunk.vector ?? null,
        );
        const chunkId = Number(inserted.lastInsertRowid);
        updateNodeId.run(chunkId, chunkId);
        chunkIds.push(chunkId);
        nodeIds.push(chunkId);
      });

      const metadataGeneration = this._incrementMetadataGeneration();
      this._setMetaInTransaction("tdb.vector_dirty", "1");
      return {
        fileId,
        chunkIds,
        nodeIds,
        removedChunkIds: oldRows.map((row) => row.id),
        removedNodeIds: oldRows.map((row) => row.node_id),
        metadataGeneration,
      };
    });
    return transaction();
  }

  async deleteDocumentState(
    library: string,
    path: string,
  ): Promise<TdbDeleteDocumentStateResult> {
    const transaction = this.db.transaction(() => {
      const file = this.db
        .prepare("SELECT id FROM files WHERE library = ? AND path = ?")
        .get(library, path) as { id?: number } | undefined;
      if (file?.id == null) {
        return {
          removed: false,
          fileId: null,
          chunkIds: [],
          nodeIds: [],
          metadataGeneration: this._readMetadataGeneration(),
        };
      }
      const rows = this.db
        .prepare("SELECT id, node_id FROM chunks WHERE library = ? AND path = ?")
        .all(library, path) as Array<{ id: number; node_id: number }>;
      this.db
        .prepare("DELETE FROM chunks WHERE library = ? AND path = ?")
        .run(library, path);
      this.db
        .prepare("DELETE FROM files WHERE library = ? AND path = ?")
        .run(library, path);
      const metadataGeneration = this._incrementMetadataGeneration();
      this._setMetaInTransaction("tdb.vector_dirty", "1");
      return {
        removed: true,
        fileId: Number(file.id),
        chunkIds: rows.map((row) => row.id),
        nodeIds: rows.map((row) => row.node_id),
        metadataGeneration,
      };
    });
    return transaction();
  }

  /**
   * @param {string} library
   * @param {string} path
   * @returns {Promise<object|null>}
   */
  async getFile(library: string, path: string): Promise<TdbFileRow | null> {
    const row = this.db
      .prepare("SELECT * FROM files WHERE library = ? AND path = ?")
      .get(library, path) as TdbFileQueryRow | undefined;
    return row ? this._fileRow(row) : null;
  }

  /**
   * @param {number} id
   * @returns {Promise<object|null>}
   */
  async getFileById(id: number): Promise<TdbFileRow | null> {
    const row = this.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as
      TdbFileQueryRow | undefined;
    return row ? this._fileRow(row) : null;
  }

  /**
   * File row owning a chunk (node_id lookup) — reverse resolution used by
   * the fusion / decay stages.
   * @param {number} chunkId
   * @returns {Promise<object|null>}
   */
  async getFileByChunkId(chunkId: number): Promise<TdbFileRow | null> {
    const row = this.db
      .prepare(
        `
        SELECT f.*
        FROM chunks c
        JOIN files f ON f.library = c.library AND f.path = c.path
        WHERE c.node_id = ?
    `,
      )
      .get(Number(chunkId)) as TdbFileQueryRow | undefined;
    return row ? this._fileRow(row) : null;
  }

  /**
   * Remove a file and its chunk rows.
   * @param {string} library
   * @param {string} path
   * @returns {Promise<{chunkIds:number[], nodeIds:number[]}>}
   */
  async deleteFile(
    library: string,
    path: string,
  ): Promise<{ chunkIds: number[]; nodeIds: number[] }> {
    const result = await this.deleteDocumentState(library, path);
    return {
      chunkIds: result.chunkIds,
      nodeIds: result.nodeIds,
    };
  }

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
  async insertChunks(
    library: string,
    path: string,
    chunks: readonly TdbChunkInput[],
  ): Promise<TdbInsertedChunk[]> {
    const transaction = this.db.transaction((): TdbInsertedChunk[] => {
      const file = this.db
        .prepare("SELECT id FROM files WHERE library = ? AND path = ?")
        .get(library, path) as { id?: number } | undefined;
      if (file?.id == null) {
        throw new Error(`TDB file does not exist: ${library}/${path}`);
      }
      this.db
        .prepare("DELETE FROM chunks WHERE library = ? AND path = ?")
        .run(library, path);
      const insert = this.db.prepare(`
          INSERT INTO chunks
            (library, path, chunk_index, node_id, text, checksum, vector)
          VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const result: TdbInsertedChunk[] = [];
      for (const [index, chunk] of chunks.entries()) {
        const info = insert.run(
          library,
          path,
          index,
          0,
          chunk.text,
          chunk.checksum,
          chunk.vector ?? null,
        );
        const chunkId = Number(info.lastInsertRowid);
        this.db
          .prepare("UPDATE chunks SET node_id = ? WHERE id = ?")
          .run(chunkId, chunkId);
        result.push({ chunkId, nodeId: chunkId });
      }
      this._incrementMetadataGeneration();
      this._setMetaInTransaction("tdb.vector_dirty", "1");
      return result;
    });
    return transaction();
  }

  /**
   * @param {string} library
   * @param {string} path
   * @returns {Promise<Array<{id:number, chunkIndex:number, nodeId:number, text:string, checksum:string}>>}
   */
  async getChunks(library: string, path: string): Promise<TdbChunkRow[]> {
    const rows = this.db
      .prepare(
        "SELECT id, chunk_index, node_id, text, checksum, vector FROM chunks WHERE library = ? AND path = ? ORDER BY chunk_index",
      )
      .all(library, path) as Array<
      Pick<
        TdbChunkQueryRow,
        "id" | "chunk_index" | "node_id" | "text" | "checksum" | "vector"
      >
    >;
    return rows.map((r) => ({
      library,
      path,
      id: r.id,
      chunkIndex: r.chunk_index,
      nodeId: r.node_id,
      text: r.text,
      checksum: r.checksum,
      vector: r.vector ?? null,
    }));
  }

  /**
   * @param {number} id
   * @returns {Promise<object|null>}
   */
  async getChunkById(id: number): Promise<TdbChunkRow | null> {
    const row = this.db
      .prepare(
        "SELECT id, library, path, chunk_index, node_id, text, checksum, vector FROM chunks WHERE id = ?",
      )
      .get(Number(id)) as TdbChunkQueryRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      library: row.library,
      path: row.path,
      chunkIndex: row.chunk_index,
      nodeId: row.node_id,
      text: row.text,
      checksum: row.checksum,
      vector: row.vector ?? null,
    };
  }

  /**
   * Corpus access for the BM25 keyword stage (chunk id → text).
   * @returns {Promise<Array<{id:number, content:string}>>}
   */
  async getAllChunks(): Promise<TdbCorpusChunk[]> {
    const rows = this.db
      .prepare("SELECT id, library, text FROM chunks ORDER BY id")
      .all() as Array<{ id: number; library: string; text: string }>;
    return rows.map((r) => ({ id: r.id, content: r.text, indexName: r.library }));
  }

  async getSearchCorpus(libraries?: readonly string[]): Promise<SearchCorpusChunk[]> {
    if (Array.isArray(libraries) && libraries.length === 0) return [];
    const names = Array.isArray(libraries)
      ? [...new Set(libraries.map((name) => String(name).trim()).filter(Boolean))]
      : [];
    let sql = "SELECT id, library, text FROM chunks";
    const params: string[] = [];
    if (names.length > 0) {
      sql += ` WHERE library IN (${names.map(() => "?").join(", ")})`;
      params.push(...names);
    }
    sql += " ORDER BY id";
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number;
      library: string;
      text: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      content: row.text,
      indexName: row.library,
    }));
  }

  // ── Libraries ────────────────────────────────────────────────────

  /**
   * @returns {Promise<string[]>}
   */
  async listLibraries(): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT DISTINCT library FROM files ORDER BY library")
      .all() as Array<{ library: string }>;
    return rows.map((r) => r.library);
  }

  /**
   * gated-over/blob name for the generic VectorSearcherStage.
   * @returns {Promise<string[]>}
   */
  async getDistinctDiaryNames() {
    return this.listLibraries();
  }

  async getExpectedVectorIndexNames(): Promise<string[]> {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT library FROM chunks WHERE vector IS NOT NULL ORDER BY library",
      )
      .all() as Array<{ library: string }>;
    return rows.map((row) => row.library).filter(Boolean);
  }

  async getTdbRebuildChunks(): Promise<TdbRebuildChunk[]> {
    const rows = this.db
      .prepare("SELECT id, node_id, library, text, vector FROM chunks ORDER BY id")
      .all() as Array<{
      id: number;
      node_id: number;
      library: string;
      text: string;
      vector?: Buffer | null;
    }>;
    return rows.map((row) => ({
      chunkId: row.id,
      nodeId: row.node_id,
      library: row.library,
      text: row.text,
      vector: row.vector ?? null,
    }));
  }

  async updateChunkVectors(
    entries: readonly { chunkId: number; vector: Buffer | null }[],
  ): Promise<void> {
    const update = this.db.prepare("UPDATE chunks SET vector = ? WHERE id = ?");
    this.db.transaction(() => {
      for (const entry of entries) update.run(entry.vector, entry.chunkId);
      if (entries.length > 0) {
        this._incrementMetadataGeneration();
        this._setMetaInTransaction("tdb.vector_dirty", "1");
      }
    })();
  }

  async countFiles(): Promise<number> {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM files").get() as {
      c?: number;
    };
    return Number(row?.c) || 0;
  }

  // ── KV ───────────────────────────────────────────────────────────

  async getMeta(key: string): Promise<string | null> {
    const row = this.db.prepare("SELECT value FROM tdb_meta WHERE key = ?").get(key) as
      TdbMetaRow | undefined;
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this._setMetaInTransaction(key, String(value));
  }

  private _setMetaInTransaction(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO tdb_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, String(value));
  }

  private _readMetadataGeneration(): number {
    const row = this.db
      .prepare("SELECT value FROM tdb_meta WHERE key = ?")
      .get("tdb.metadata_generation") as TdbMetaRow | undefined;
    const value = Number(row?.value);
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }

  private _incrementMetadataGeneration(): number {
    const next = this._readMetadataGeneration() + 1;
    this._setMetaInTransaction("tdb.metadata_generation", String(next));
    return next;
  }

  async getTdbGenerationState(): Promise<TdbGenerationState> {
    const metadataGeneration = this._readMetadataGeneration();
    const vectorGenerationValue = Number(await this.getMeta("tdb.vector_generation"));
    const dirtyValue = await this.getMeta("tdb.vector_dirty");
    return {
      metadataGeneration,
      vectorGeneration: Number.isFinite(vectorGenerationValue)
        ? Math.max(0, Math.floor(vectorGenerationValue))
        : 0,
      vectorDirty: dirtyValue !== "0",
    };
  }

  async markTdbVectorStateClean(): Promise<void> {
    const transaction = this.db.transaction(() => {
      const generation = this._readMetadataGeneration();
      this._setMetaInTransaction("tdb.vector_generation", String(generation));
      this._setMetaInTransaction("tdb.vector_dirty", "0");
    });
    transaction();
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

  private _fileRow(row: TdbFileQueryRow): TdbFileRow {
    return {
      id: row.id,
      library: row.library,
      path: row.path,
      checksum: row.checksum,
      mtime: row.mtime,
      size: row.size,
      doc_node_id: row.doc_node_id ?? null,
      updated_at: row.updated_at ?? null,
    };
  }
}

export default TDBStore;
