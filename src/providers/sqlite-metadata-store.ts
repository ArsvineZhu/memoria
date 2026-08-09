"use strict";

import MetadataStore from "../interfaces/metadata-store.js";
import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";
import type {
  ChunkMetadataInput,
  ChunkRow,
  DocumentStateReplacement,
  DocumentStateReplacementResult,
  FileMetadataInput,
  FileRow,
  FileTagRow,
  GenerationState,
  IndexableChunkRow,
  HealthStatus,
  TagMetadataInput,
  TagRow,
} from "../types.js";

const requireFromProvider = createRequire(import.meta.url);
let DatabaseCtor: typeof BetterSqlite3 | null = null;

function loadDatabaseCtor(): typeof BetterSqlite3 | null {
  if (DatabaseCtor) return DatabaseCtor;
  try {
    const loaded = requireFromProvider("better-sqlite3") as
      typeof BetterSqlite3 | { default?: typeof BetterSqlite3 };
    DatabaseCtor = typeof loaded === "function" ? loaded : (loaded.default ?? null);
  } catch (_) {
    DatabaseCtor = null;
  }
  return DatabaseCtor;
}

interface SqliteConfig {
  dbPath?: string;
  dimension?: number;
  busyTimeout?: number;
  busyRetryDelay?: number;
}

interface FileQueryRow {
  id: number;
  path: string;
  diary_name: string;
  checksum: string;
  mtime: number;
  size: number;
  updated_at?: number | null;
  document_id?: string | null;
  revision?: string | null;
  source_json?: string | null;
  metadata_json?: string | null;
}

interface ChunkQueryRow {
  id: number;
  file_id: number;
  chunk_index: number;
  content: string;
  vector?: Buffer | null;
}

interface TagQueryRow {
  id: number;
  name: string;
  vector?: Buffer | null;
}

interface FileTagQueryRow {
  id: number;
  name: string;
  position: number;
}

interface CooccurrenceRow {
  tag1: number;
  tag2: number;
  weight: number;
}

interface KeyValueRow {
  value?: string | null;
}

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        diary_name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        updated_at INTEGER,
        document_id TEXT,
        revision TEXT,
        source_json TEXT,
        metadata_json TEXT
    );
    CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        vector BLOB,
        FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        vector BLOB
    );
    CREATE TABLE IF NOT EXISTS file_tags (
        file_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (file_id, tag_id),
        FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE,
        FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT,
        vector BLOB
    );
`;

const METADATA_GENERATION_KEY = "memoria.metadata_generation";
const VECTOR_GENERATION_KEY = "memoria.vector_generation";
const VECTOR_DIRTY_KEY = "memoria.vector_dirty";

/**
 * SQLite-backed metadata store using better-sqlite3.
 *
 * Consolidates schema initialization, file/chunk/tag CRUD, co-occurrence
 * matrix building, and health-check logic from modules/knowledgeBase/
 * (schemaManager.js, sqliteHealthManager.js, ingestionPipeline.js).
 *
 * All methods are async to satisfy the MetadataStore interface, but the
 * underlying better-sqlite3 calls are synchronous.
 */
class SqliteMetadataStore extends MetadataStore {
  dbPath: string;
  dimension: number | null;
  busyTimeout: number;
  busyRetryDelay: number;
  _closed: boolean;
  db: BetterSqlite3.Database;
  /**
   * @param {object} config
   * @param {string} config.dbPath          - SQLite file path (or ':memory:')
   * @param {number} [config.dimension]     - Vector dimension (stored for reference)
   * @param {number} [config.busyTimeout]   - SQLite busy_timeout in ms (default 10000)
   * @param {number} [config.busyRetryDelay]- Delay between busy retries in ms (default 100)
   */
  constructor(config: SqliteConfig = {}) {
    super();

    const Database = loadDatabaseCtor();
    if (!Database) {
      throw new Error(
        "better-sqlite3 is not available. Install it with: pnpm add better-sqlite3",
      );
    }

    this.dbPath = config.dbPath || ":memory:";
    this.dimension = config.dimension || null;
    this.busyTimeout = config.busyTimeout || 10000;
    this.busyRetryDelay = config.busyRetryDelay || 100;
    this._closed = false;

    this.db = new Database(this.dbPath);
    this._configureConnection();
    this._initializeSchema();
  }

  _configureConnection(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma(`busy_timeout = ${this.busyTimeout}`);
  }

  _initializeSchema(): void {
    this.db.exec(SCHEMA_SQL);
    const columns = this.db.prepare("PRAGMA table_info(files)").all() as Array<{
      name: string;
    }>;
    const existingColumns = new Set(columns.map((column) => column.name));
    const migrations: Array<[string, string]> = [
      ["document_id", "TEXT"],
      ["revision", "TEXT"],
      ["source_json", "TEXT"],
      ["metadata_json", "TEXT"],
    ];
    for (const [name, definition] of migrations) {
      if (!existingColumns.has(name)) {
        this.db.exec(`ALTER TABLE files ADD COLUMN ${name} ${definition}`);
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_files_diary ON files(diary_name);
      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
      CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);
      CREATE INDEX IF NOT EXISTS idx_file_tags_composite ON file_tags(tag_id, file_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_files_document_id
        ON files(document_id) WHERE document_id IS NOT NULL;
    `);
    this.db
      .prepare("INSERT OR IGNORE INTO kv_store (key, value) VALUES (?, ?)")
      .run(METADATA_GENERATION_KEY, "0");
    this.db
      .prepare("INSERT OR IGNORE INTO kv_store (key, value) VALUES (?, ?)")
      .run(VECTOR_GENERATION_KEY, "0");
    this.db
      .prepare("INSERT OR IGNORE INTO kv_store (key, value) VALUES (?, ?)")
      .run(VECTOR_DIRTY_KEY, "1");
  }

  _incrementMetadataGenerationInTransaction(): number {
    const generationRow = this.db
      .prepare("SELECT value FROM kv_store WHERE key = ?")
      .get(METADATA_GENERATION_KEY) as KeyValueRow | undefined;
    const currentGeneration = Number.parseInt(generationRow?.value ?? "0", 10);
    const metadataGeneration =
      Number.isSafeInteger(currentGeneration) && currentGeneration >= 0
        ? currentGeneration + 1
        : 1;
    const setKv = this.db.prepare(
      "INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)",
    );
    setKv.run(METADATA_GENERATION_KEY, String(metadataGeneration));
    setKv.run(VECTOR_DIRTY_KEY, "1");
    return metadataGeneration;
  }

  // ── File CRUD ───────────────────────────────────────────────

  override async upsertFile(fileMeta: FileMetadataInput): Promise<number | null> {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
        INSERT INTO files (
            path, diary_name, checksum, mtime, size, updated_at,
            document_id, revision, source_json, metadata_json
        )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                diary_name = excluded.diary_name,
                checksum = excluded.checksum,
                mtime = excluded.mtime,
                size = excluded.size,
                updated_at = excluded.updated_at,
                document_id = excluded.document_id,
                revision = excluded.revision,
                source_json = excluded.source_json,
                metadata_json = excluded.metadata_json
        `);
    stmt.run(
      fileMeta.path,
      fileMeta.diaryName,
      fileMeta.checksum,
      fileMeta.mtime,
      fileMeta.size,
      now,
      fileMeta.documentId ?? null,
      fileMeta.revision ?? null,
      fileMeta.sourceJson ?? null,
      fileMeta.metadataJson ?? null,
    );
    const row = this.db
      .prepare("SELECT id FROM files WHERE path = ?")
      .get(fileMeta.path) as { id: number } | undefined;
    return row ? Number(row.id) : null;
  }

  async updateDocumentMetadata(
    fileMeta: FileMetadataInput,
  ): Promise<{ fileId: number; changed: boolean }> {
    const existing = this.db
      .prepare("SELECT * FROM files WHERE path = ?")
      .get(fileMeta.path) as FileQueryRow | undefined;
    if (!existing) {
      const fileId = await this.upsertFile(fileMeta);
      if (fileId == null) {
        throw new Error("Unable to persist file metadata");
      }
      return { fileId, changed: true };
    }

    const changed =
      existing.diary_name !== fileMeta.diaryName ||
      existing.checksum !== fileMeta.checksum ||
      existing.mtime !== fileMeta.mtime ||
      existing.size !== fileMeta.size ||
      (existing.document_id ?? null) !== (fileMeta.documentId ?? null) ||
      (existing.revision ?? null) !== (fileMeta.revision ?? null) ||
      (existing.source_json ?? null) !== (fileMeta.sourceJson ?? null) ||
      (existing.metadata_json ?? null) !== (fileMeta.metadataJson ?? null);

    if (!changed) return { fileId: Number(existing.id), changed: false };

    this.db
      .prepare(
        `UPDATE files SET
          diary_name = ?, checksum = ?, mtime = ?, size = ?, updated_at = ?,
          document_id = ?, revision = ?, source_json = ?, metadata_json = ?
         WHERE id = ?`,
      )
      .run(
        fileMeta.diaryName,
        fileMeta.checksum,
        fileMeta.mtime,
        fileMeta.size,
        Math.floor(Date.now() / 1000),
        fileMeta.documentId ?? null,
        fileMeta.revision ?? null,
        fileMeta.sourceJson ?? null,
        fileMeta.metadataJson ?? null,
        existing.id,
      );
    return { fileId: Number(existing.id), changed: true };
  }

  async countFiles(): Promise<number> {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM files").get() as
      { c?: number } | undefined;
    return Number(row?.c) || 0;
  }

  async getLastIndexedAt(): Promise<number | null> {
    const row = this.db.prepare("SELECT MAX(updated_at) AS m FROM files").get() as
      { m?: number | null } | undefined;
    return row?.m == null ? null : Number(row.m) * 1000;
  }

  override async getFileByPath(path: string): Promise<FileRow | null> {
    return (
      (this.db.prepare("SELECT * FROM files WHERE path = ?").get(path) as
        FileQueryRow | undefined) || null
    );
  }

  override async getFileByDocumentId(documentId: string): Promise<FileRow | null> {
    return (
      (this.db.prepare("SELECT * FROM files WHERE document_id = ?").get(documentId) as
        FileQueryRow | undefined) || null
    );
  }

  override async getDistinctDiaryNames(): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT DISTINCT diary_name FROM files WHERE diary_name != ?")
      .all("");
    return (rows as FileQueryRow[])
      .map((r: FileQueryRow) => r.diary_name)
      .filter(Boolean);
  }

  override async getFileByChunkId(chunkId: number): Promise<FileRow | null> {
    return (
      (this.db
        .prepare(
          `
            SELECT f.*
            FROM chunks c
            JOIN files f ON c.file_id = f.id
            WHERE c.id = ?
        `,
        )
        .get(chunkId) as FileQueryRow | undefined) || null
    );
  }

  override async deleteFile(fileId: number): Promise<void> {
    const deleteFile = this.db.prepare("DELETE FROM files WHERE id = ?");
    this.db.transaction(() => {
      const result = deleteFile.run(fileId);
      if (Number(result.changes) > 0) this._incrementMetadataGenerationInTransaction();
    })();
  }

  // ── Chunk CRUD ──────────────────────────────────────────────

  override async insertChunks(
    fileId: number,
    chunks: readonly ChunkMetadataInput[],
  ): Promise<number[]> {
    const delStmt = this.db.prepare("DELETE FROM chunks WHERE file_id = ?");
    const insertStmt = this.db.prepare(
      "INSERT INTO chunks (file_id, chunk_index, content, vector) VALUES (?, ?, ?, ?)",
    );

    const ids = this.db.transaction(() => {
      delStmt.run(fileId);
      const result: number[] = [];
      for (const chunk of chunks) {
        const info = insertStmt.run(
          fileId,
          chunk.chunkIndex,
          chunk.content,
          chunk.vector || null,
        );
        result.push(Number(info.lastInsertRowid));
      }
      return result;
    })();

    return ids;
  }

  async replaceDocumentState(
    replacement: DocumentStateReplacement,
  ): Promise<DocumentStateReplacementResult> {
    const { file, chunks, tags, orderedTagNames } = replacement;
    const now = Math.floor(Date.now() / 1000);

    const result = this.db.transaction(() => {
      const existingByDocument = file.documentId
        ? (this.db
            .prepare("SELECT * FROM files WHERE document_id = ?")
            .get(file.documentId) as FileQueryRow | undefined)
        : undefined;
      const existing =
        existingByDocument ||
        (this.db.prepare("SELECT * FROM files WHERE path = ?").get(file.path) as
          FileQueryRow | undefined);
      const previousIndexName = existing?.diary_name ?? null;
      const removedChunkIds = existing
        ? (
            this.db
              .prepare("SELECT id FROM chunks WHERE file_id = ? ORDER BY id")
              .all(existing.id) as Array<{ id: number }>
          ).map((row) => Number(row.id))
        : [];

      let fileId: number;
      const fileValues = [
        file.path,
        file.diaryName,
        file.checksum,
        file.mtime,
        file.size,
        now,
        file.documentId ?? null,
        file.revision ?? null,
        file.sourceJson ?? null,
        file.metadataJson ?? null,
      ] as const;
      if (existing) {
        this.db
          .prepare(
            `UPDATE files SET
              path = ?, diary_name = ?, checksum = ?, mtime = ?, size = ?,
              updated_at = ?, document_id = ?, revision = ?, source_json = ?,
              metadata_json = ?
            WHERE id = ?`,
          )
          .run(...fileValues, existing.id);
        fileId = existing.id;
      } else {
        const insertFile = this.db.prepare(
          `INSERT INTO files (
            path, diary_name, checksum, mtime, size, updated_at,
            document_id, revision, source_json, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const info = insertFile.run(...fileValues);
        fileId = Number(info.lastInsertRowid);
      }

      const deleteChunks = this.db.prepare("DELETE FROM chunks WHERE file_id = ?");
      deleteChunks.run(fileId);
      const insertChunk = this.db.prepare(
        "INSERT INTO chunks (file_id, chunk_index, content, vector) VALUES (?, ?, ?, ?)",
      );
      const chunkIds: number[] = [];
      for (const chunk of chunks) {
        const info = insertChunk.run(
          fileId,
          chunk.chunkIndex,
          chunk.content,
          chunk.vector ?? null,
        );
        chunkIds.push(Number(info.lastInsertRowid));
      }

      const insertTag = this.db.prepare(
        "INSERT OR IGNORE INTO tags (name, vector) VALUES (?, ?)",
      );
      const updateTagVector = this.db.prepare(
        "UPDATE tags SET vector = ? WHERE name = ?",
      );
      const selectTag = this.db.prepare("SELECT id, vector FROM tags WHERE name = ?");
      const tagIdsByName = new Map<string, number>();
      const tagIds: number[] = [];
      for (const tag of tags) {
        insertTag.run(tag.name, tag.vector ?? null);
        if (tag.vector !== null) updateTagVector.run(tag.vector, tag.name);
        const row = selectTag.get(tag.name) as
          { id: number; vector?: Buffer | null } | undefined;
        if (!row) continue;
        const tagId = Number(row.id);
        tagIds.push(tagId);
        tagIdsByName.set(tag.name, tagId);
      }

      const fileTagIds: number[] = [];
      for (const tagName of orderedTagNames) {
        let tagId = tagIdsByName.get(tagName);
        if (tagId === undefined) {
          const stored = selectTag.get(tagName) as
            { id: number; vector?: Buffer | null } | undefined;
          if (stored?.vector != null) tagId = Number(stored.id);
        }
        if (tagId !== undefined) fileTagIds.push(tagId);
      }

      this.db.prepare("DELETE FROM file_tags WHERE file_id = ?").run(fileId);
      const insertFileTag = this.db.prepare(
        "INSERT INTO file_tags (file_id, tag_id, position) VALUES (?, ?, ?)",
      );
      fileTagIds.forEach((tagId, index) => {
        insertFileTag.run(fileId, tagId, index + 1);
      });

      const metadataGeneration = this._incrementMetadataGenerationInTransaction();

      return {
        fileId,
        chunkIds,
        tagIds,
        removedChunkIds,
        metadataGeneration,
        previousIndexName,
        currentIndexName: file.diaryName,
      };
    })();

    return result;
  }

  override async getChunksByFileId(fileId: number): Promise<ChunkRow[]> {
    const rows = this.db
      .prepare(
        "SELECT id, file_id, chunk_index, content, vector FROM chunks WHERE file_id = ? ORDER BY chunk_index",
      )
      .all(fileId);
    return (rows as ChunkQueryRow[]).map((r: ChunkQueryRow) => ({
      id: r.id,
      fileId: r.file_id,
      chunkIndex: r.chunk_index,
      content: r.content,
      vector: r.vector || null,
    }));
  }

  override async getChunkById(id: number): Promise<ChunkRow | null> {
    const row = this.db
      .prepare(
        "SELECT id, file_id, chunk_index, content, vector FROM chunks WHERE id = ?",
      )
      .get(id) as ChunkQueryRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      fileId: row.file_id,
      chunkIndex: row.chunk_index,
      content: row.content,
      vector: row.vector || null,
    };
  }

  override async getAllChunks(): Promise<ChunkRow[]> {
    const rows = this.db
      .prepare(
        "SELECT id, file_id, chunk_index, content, vector FROM chunks ORDER BY id",
      )
      .all();
    return (rows as ChunkQueryRow[]).map((r: ChunkQueryRow) => ({
      id: r.id,
      fileId: r.file_id,
      chunkIndex: r.chunk_index,
      content: r.content,
      vector: r.vector || null,
    }));
  }

  async getIndexableChunks(): Promise<IndexableChunkRow[]> {
    const rows = this.db
      .prepare(
        `
          SELECT c.id AS chunk_id, c.vector, f.diary_name AS index_name
          FROM chunks c
          JOIN files f ON c.file_id = f.id
          ORDER BY c.id
        `,
      )
      .all() as Array<{
      chunk_id: number;
      vector?: Buffer | null;
      index_name?: string | null;
    }>;
    return rows.map((row) => ({
      chunkId: Number(row.chunk_id),
      vector: row.vector ?? null,
      indexName: row.index_name || "Root",
    }));
  }

  async getExpectedVectorIndexNames(): Promise<string[]> {
    const names = (
      this.db
        .prepare(
          "SELECT DISTINCT diary_name FROM files WHERE diary_name IS NOT NULL AND diary_name != '' ORDER BY diary_name",
        )
        .all() as Array<{ diary_name?: string | null }>
    )
      .map((row) => row.diary_name || "")
      .filter(Boolean);
    const tagRow = this.db.prepare("SELECT 1 AS present FROM tags LIMIT 1").get() as
      { present?: number } | undefined;
    if (tagRow?.present) names.push("global_tags");
    return [...new Set(names)].sort();
  }

  // ── Tag CRUD ────────────────────────────────────────────────

  override async upsertTags(tags: readonly TagMetadataInput[]): Promise<number[]> {
    if (!tags || tags.length === 0) return [];

    const insertStmt = this.db.prepare(
      "INSERT OR IGNORE INTO tags (name, vector) VALUES (?, ?)",
    );
    const updateVectorStmt = this.db.prepare(
      "UPDATE tags SET vector = ? WHERE name = ?",
    );
    const getIdStmt = this.db.prepare("SELECT id FROM tags WHERE name = ?");

    const ids = this.db.transaction(() => {
      const result: number[] = [];
      for (const tag of tags) {
        insertStmt.run(tag.name, tag.vector || null);
        if (tag.vector) {
          updateVectorStmt.run(tag.vector, tag.name);
        }
        const row = getIdStmt.get(tag.name) as { id: number } | undefined;
        if (row) result.push(Number(row.id));
      }
      return result;
    })();

    return ids;
  }

  override async getTagByName(name: string): Promise<TagRow | null> {
    const row = this.db
      .prepare("SELECT id, name, vector FROM tags WHERE name = ?")
      .get(name) as TagQueryRow | undefined;
    if (!row) return null;
    return { id: row.id, name: row.name, vector: row.vector || null };
  }

  override async getAllTags(): Promise<TagRow[]> {
    const rows = this.db.prepare("SELECT id, name, vector FROM tags ORDER BY id").all();
    return (rows as TagQueryRow[]).map((r: TagQueryRow) => ({
      id: r.id,
      name: r.name,
      vector: r.vector || null,
    }));
  }

  // ── File-Tag associations ───────────────────────────────────

  override async setFileTags(fileId: number, tagIds: readonly number[]): Promise<void> {
    if (!tagIds || tagIds.length === 0) {
      this.db.prepare("DELETE FROM file_tags WHERE file_id = ?").run(fileId);
      return;
    }

    const delStmt = this.db.prepare("DELETE FROM file_tags WHERE file_id = ?");
    const insertStmt = this.db.prepare(
      "INSERT OR IGNORE INTO file_tags (file_id, tag_id, position) VALUES (?, ?, ?)",
    );

    this.db.transaction(() => {
      delStmt.run(fileId);
      tagIds.forEach((tagId: number, index: number) => {
        insertStmt.run(fileId, tagId, index + 1);
      });
    })();
  }

  override async getFileTags(fileId: number): Promise<FileTagRow[]> {
    const rows = this.db
      .prepare(
        `
            SELECT t.id, t.name, ft.position
            FROM file_tags ft
            JOIN tags t ON ft.tag_id = t.id
            WHERE ft.file_id = ?
            ORDER BY ft.position
        `,
      )
      .all(fileId);
    return (rows as FileTagQueryRow[]).map((r: FileTagQueryRow) => ({
      id: r.id,
      name: r.name,
      position: r.position,
    }));
  }

  override async getFileIdsByTagId(tagId: number): Promise<number[]> {
    const rows = this.db
      .prepare("SELECT DISTINCT file_id FROM file_tags WHERE tag_id = ?")
      .all(tagId);
    return (rows as Array<{ file_id: number }>).map(
      (r: { file_id: number }) => r.file_id,
    );
  }

  // ── Co-occurrence ───────────────────────────────────────────

  override async buildCooccurrenceMatrix(): Promise<Map<number, Map<number, number>>> {
    const stmt = this.db.prepare(`
            SELECT ft1.tag_id as tag1, ft2.tag_id as tag2, COUNT(ft1.file_id) as weight
            FROM file_tags ft1
            JOIN file_tags ft2 ON ft1.file_id = ft2.file_id AND ft1.tag_id < ft2.tag_id
            GROUP BY ft1.tag_id, ft2.tag_id
        `);

    const matrix = new Map<number, Map<number, number>>();
    for (const row of stmt.iterate() as IterableIterator<CooccurrenceRow>) {
      if (!matrix.has(row.tag1)) matrix.set(row.tag1, new Map());
      if (!matrix.has(row.tag2)) matrix.set(row.tag2, new Map());

      const tag1Row = matrix.get(row.tag1);
      const tag2Row = matrix.get(row.tag2);
      if (!tag1Row || !tag2Row) continue;
      tag1Row.set(row.tag2, row.weight);
      tag2Row.set(row.tag1, row.weight);
    }
    return matrix;
  }

  // ── KV store ────────────────────────────────────────────────

  async getKv(key: string): Promise<string | null> {
    const row = this.db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key) as
      KeyValueRow | undefined;
    return row?.value ?? null;
  }

  async setKv(key: string, value: string): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  async getGenerationState(): Promise<GenerationState> {
    const values = await Promise.all([
      this.getKv(METADATA_GENERATION_KEY),
      this.getKv(VECTOR_GENERATION_KEY),
      this.getKv(VECTOR_DIRTY_KEY),
    ]);
    const parseGeneration = (value: string | null): number => {
      const parsed = Number.parseInt(value ?? "0", 10);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    };
    return {
      metadataGeneration: parseGeneration(values[0]),
      vectorGeneration: parseGeneration(values[1]),
      vectorDirty: values[2] !== "0",
    };
  }

  async markVectorStateClean(): Promise<void> {
    this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT value FROM kv_store WHERE key = ?")
        .get(METADATA_GENERATION_KEY) as KeyValueRow | undefined;
      const metadataGeneration = row?.value ?? "0";
      const setKv = this.db.prepare(
        "INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)",
      );
      setKv.run(VECTOR_GENERATION_KEY, metadataGeneration);
      setKv.run(VECTOR_DIRTY_KEY, "0");
    })();
  }

  // ── Health ──────────────────────────────────────────────────

  override async checkpoint(): Promise<void> {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  override async healthCheck(): Promise<HealthStatus> {
    const issues: string[] = [];
    try {
      this.db.prepare("SELECT 1").get();
    } catch (e) {
      issues.push(e instanceof Error ? e.message : String(e));
    }
    try {
      const row = this.db.prepare("PRAGMA quick_check").get();
      const result = row ? Object.values(row)[0] : "ok";
      if (result !== "ok") {
        issues.push(`quick_check: ${result}`);
      }
    } catch (e) {
      issues.push(`quick_check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { healthy: issues.length === 0, issues };
  }

  // ── Lifecycle ───────────────────────────────────────────────

  close(): void {
    if (this._closed) return;
    this.db.close();
    this._closed = true;
  }
}

export default SqliteMetadataStore;
