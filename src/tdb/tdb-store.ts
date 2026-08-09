"use strict";

import BetterSqlite3 from "better-sqlite3";
import type {
  HealthStatus,
  TdbChunkInput,
  TdbChunkRow,
  TdbCorpusChunk,
  TdbFileRow,
  TdbInsertedChunk,
  TdbStoreContract,
} from "../types.js";

/**
 * TDBStore — dedicated SQLite metadata layer for the TDB (TriviumDB
 * cold-knowledge) engine.
 *
 * Mirrors the table shape of TDBKnowledge.js (VectorStoreTDB/
 * tdb_knowledge_meta.sqlite): per-library `files` rows carry the document
 * checksum / mtime / size bookkeeping while `chunks` map chunk_index →
 * vector node id. One local deviation: the `chunks.text` column stores the
 * chunk text itself, replacing the original TriviumDB native payload, since
 * this library has no native text index (the BM25 stage reads it).
 *
 * All methods are async to match the MetadataStore conventions, though the
 * underlying better-sqlite3 calls are synchronous.
 */

let DatabaseCtor: typeof BetterSqlite3 | null = BetterSqlite3;

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
    if (!DatabaseCtor) {
      throw new Error(
        "better-sqlite3 is not available. Install it with: pnpm add better-sqlite3",
      );
    }
    this.dbPath = config.dbPath || ":memory:";
    this.busyTimeout = config.busyTimeout || 10000;
    this._closed = false;

    this.db = new DatabaseCtor(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma(`busy_timeout = ${this.busyTimeout}`);
    this.db.exec(SCHEMA_SQL);
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
    return row?.id ?? null;
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
    const chunkRows = this.db
      .prepare("SELECT id, node_id FROM chunks WHERE library = ? AND path = ?")
      .all(library, path) as Array<{ id: number; node_id: number }>;
    this.db
      .prepare("DELETE FROM chunks WHERE library = ? AND path = ?")
      .run(library, path);
    this.db
      .prepare("DELETE FROM files WHERE library = ? AND path = ?")
      .run(library, path);
    return {
      chunkIds: chunkRows.map((r) => r.id),
      nodeIds: chunkRows.map((r) => r.node_id),
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
    if (!chunks || chunks.length === 0) return [];
    this.db
      .prepare("DELETE FROM chunks WHERE library = ? AND path = ?")
      .run(library, path);

    const insert = this.db.prepare(`
        INSERT INTO chunks (library, path, chunk_index, node_id, text, checksum)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const rows = this.db.transaction((): TdbInsertedChunk[] => {
      const result: TdbInsertedChunk[] = [];
      chunks.forEach((chunk, index) => {
        const info = insert.run(library, path, index, 0, chunk.text, chunk.checksum);
        const chunkId = Number(info.lastInsertRowid);
        this.db
          .prepare("UPDATE chunks SET node_id = ? WHERE id = ?")
          .run(chunkId, chunkId);
        result.push({ chunkId, nodeId: chunkId });
      });
      return result;
    })();
    return rows;
  }

  /**
   * @param {string} library
   * @param {string} path
   * @returns {Promise<Array<{id:number, chunkIndex:number, nodeId:number, text:string, checksum:string}>>}
   */
  async getChunks(library: string, path: string): Promise<TdbChunkRow[]> {
    const rows = this.db
      .prepare(
        "SELECT id, chunk_index, node_id, text, checksum FROM chunks WHERE library = ? AND path = ? ORDER BY chunk_index",
      )
      .all(library, path) as Array<
      Pick<TdbChunkQueryRow, "id" | "chunk_index" | "node_id" | "text" | "checksum">
    >;
    return rows.map((r) => ({
      library,
      path,
      id: r.id,
      chunkIndex: r.chunk_index,
      nodeId: r.node_id,
      text: r.text,
      checksum: r.checksum,
    }));
  }

  /**
   * @param {number} id
   * @returns {Promise<object|null>}
   */
  async getChunkById(id: number): Promise<TdbChunkRow | null> {
    const row = this.db
      .prepare(
        "SELECT id, library, path, chunk_index, node_id, text, checksum FROM chunks WHERE id = ?",
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
    };
  }

  /**
   * Corpus access for the BM25 keyword stage (chunk id → text).
   * @returns {Promise<Array<{id:number, content:string}>>}
   */
  async getAllChunks(): Promise<TdbCorpusChunk[]> {
    const rows = this.db
      .prepare("SELECT id, text FROM chunks ORDER BY id")
      .all() as Array<{ id: number; text: string }>;
    return rows.map((r) => ({ id: r.id, content: r.text }));
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

  // ── KV ───────────────────────────────────────────────────────────

  async getMeta(key: string): Promise<string | null> {
    const row = this.db.prepare("SELECT value FROM tdb_meta WHERE key = ?").get(key) as
      TdbMetaRow | undefined;
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO tdb_meta (key, value) VALUES (?, ?)")
      .run(key, String(value));
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
    this._closed = true;
    try {
      this.db.close();
    } catch (_) {
      // already closed — ignore
    }
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
