"use strict";

import MetadataStore from "../interfaces/metadata-store.js";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import type {
  ChunkMetadataInput,
  ChunkRow,
  DocumentTagReplacement,
  DocumentTagReplacementResult,
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
  SearchCorpusChunk,
  MemoryRelationRecord,
  RelationListOptions,
  MemoryRelationStatus,
  RetrievalScopeFilters,
  RetrievalScopeResolution,
  UnknownRecord,
} from "../types.js";
import { relationDocumentAliases } from "../retrieval/relation-graph.js";

const requireFromProvider = createRequire(import.meta.url);
let DatabaseCtor: typeof BetterSqlite3 | null = null;

function loadDatabaseCtor(): typeof BetterSqlite3 | null {
  if (DatabaseCtor) return DatabaseCtor;
  try {
    const loaded = requireFromProvider("better-sqlite3") as
      typeof BetterSqlite3 | { default?: typeof BetterSqlite3 };
    DatabaseCtor = typeof loaded === "function" ? loaded : (loaded.default ?? null);
  } catch {
    DatabaseCtor = null;
  }
  return DatabaseCtor;
}

function relationInputId(from: string, to: string, kind: string): string {
  return createHash("sha256")
    .update(`${from}\n${to}\n${kind}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function parseRelationJson(value: string | null | undefined): UnknownRecord | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as UnknownRecord)
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseMetadataJson(value: string | null | undefined): UnknownRecord {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function metadataPath(value: UnknownRecord, pathValue: string): unknown {
  return pathValue.split(".").reduce<unknown>((current, key) => {
    return isRecord(current) ? current[key] : undefined;
  }, value);
}

function equalMetadata(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => equalMetadata(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(right, key) &&
          equalMetadata(left[key], right[key]),
      )
    );
  }
  return false;
}

function matchesMetadataJson(
  value: string | null | undefined,
  expected: Record<string, unknown>,
): boolean {
  const metadata = parseMetadataJson(value);
  return Object.entries(expected).every(([key, expectedValue]) => {
    const actual = metadataPath(metadata, key);
    return Array.isArray(actual) && !Array.isArray(expectedValue)
      ? actual.some((item) => equalMetadata(item, expectedValue))
      : equalMetadata(actual, expectedValue);
  });
}

function scopeEpochSeconds(value: number | string | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Math.abs(value) > 1e12 ? value / 1000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

function relationFromRow(row: RelationQueryRow): MemoryRelationRecord {
  const status =
    row.status === "stale" || row.status === "rejected" ? row.status : "active";
  return {
    id: row.id,
    from: row.from_key,
    to: row.to_key,
    kind: row.kind as MemoryRelationRecord["kind"],
    origin: row.origin === "derived" ? "derived" : "source",
    confidence: Number(row.confidence) || 0,
    weight: Number(row.weight) || 0,
    evidence: row.evidence ?? null,
    provenance: parseRelationJson(row.provenance_json),
    sourceRevision: row.source_revision ?? null,
    algorithmVersion: row.algorithm_version ?? null,
    sourceSpan:
      row.source_span_start == null || row.source_span_end == null
        ? null
        : { start: row.source_span_start, end: row.source_span_end },
    targetAnchor: row.target_anchor ?? null,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    status,
    active: row.active !== 0 && status === "active",
  };
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

interface RelationQueryRow {
  id: string;
  from_key: string;
  to_key: string;
  kind: string;
  origin: string;
  confidence: number;
  weight: number;
  evidence?: string | null;
  provenance_json?: string | null;
  source_revision?: string | null;
  algorithm_version?: string | null;
  source_span_start?: number | null;
  source_span_end?: number | null;
  target_anchor?: string | null;
  status: string;
  active: number;
  created_at: number;
  updated_at: number;
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
    CREATE TABLE IF NOT EXISTS tag_intrinsic_residuals (
        tag_id INTEGER PRIMARY KEY,
        residual_energy REAL NOT NULL,
        neighbor_count INTEGER NOT NULL,
        computed_at TEXT NOT NULL DEFAULT (datetime('now')),
        raw_residual_ratio REAL,
        v8_3_compat_gain REAL,
        v9_anchor_gain REAL,
        model_sig TEXT,
        artifact_sig TEXT,
        algorithm_version TEXT,
        config_hash TEXT,
        status TEXT NOT NULL DEFAULT 'computed',
        FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS tagmemo_artifacts (
        artifact_sig TEXT PRIMARY KEY,
        asset_type TEXT NOT NULL,
        model_sig TEXT NOT NULL,
        graph_generation TEXT NOT NULL,
        algorithm_version TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        effective_config TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tagmemo_artifacts_lookup
        ON tagmemo_artifacts(asset_type, model_sig, status);
    CREATE TABLE IF NOT EXISTS tag_pair_similarity (
        tag_a INTEGER NOT NULL,
        tag_b INTEGER NOT NULL,
        similarity REAL NOT NULL,
        model_sig TEXT NOT NULL,
        computed_at INTEGER NOT NULL,
        PRIMARY KEY (tag_a, tag_b),
        FOREIGN KEY(tag_a) REFERENCES tags(id) ON DELETE CASCADE,
        FOREIGN KEY(tag_b) REFERENCES tags(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pair_sim_model
        ON tag_pair_similarity(model_sig);
    CREATE TABLE IF NOT EXISTS tag_pair_similarity_status (
        tag_a INTEGER NOT NULL,
        tag_b INTEGER NOT NULL,
        model_sig TEXT NOT NULL,
        artifact_sig TEXT NOT NULL,
        status TEXT NOT NULL,
        similarity REAL,
        min_similarity REAL NOT NULL,
        computed_at INTEGER NOT NULL,
        PRIMARY KEY (tag_a, tag_b, artifact_sig),
        FOREIGN KEY(tag_a) REFERENCES tags(id) ON DELETE CASCADE,
        FOREIGN KEY(tag_b) REFERENCES tags(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pair_sim_status_artifact
        ON tag_pair_similarity_status(artifact_sig, status);
    CREATE INDEX IF NOT EXISTS idx_pair_sim_status_model
        ON tag_pair_similarity_status(model_sig);
    CREATE TABLE IF NOT EXISTS rivermemo_artifacts (
        artifact_sig TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        algorithm_version TEXT NOT NULL,
        source_v9_artifact_sig TEXT NOT NULL,
        source_graph_generation TEXT NOT NULL,
        model_sig TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        database_generation TEXT NOT NULL,
        provenance_generation TEXT NOT NULL,
        payload_codec TEXT NOT NULL DEFAULT 'gzip-json-v1',
        payload_checksum TEXT,
        payload BLOB,
        status TEXT NOT NULL,
        error_message TEXT,
        node_count INTEGER NOT NULL DEFAULT 0,
        edge_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        published_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_rivermemo_artifacts_compatible
        ON rivermemo_artifacts(
            source_v9_artifact_sig,
            model_sig,
            config_hash,
            database_generation,
            status,
            updated_at
        );
    CREATE INDEX IF NOT EXISTS idx_rivermemo_artifacts_status
        ON rivermemo_artifacts(status, updated_at);
    CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT,
        vector BLOB
    );
    CREATE TABLE IF NOT EXISTS memory_relations (
        id TEXT PRIMARY KEY,
        from_key TEXT NOT NULL,
        to_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('source', 'derived')),
        confidence REAL NOT NULL DEFAULT 0,
        weight REAL NOT NULL DEFAULT 0,
        evidence TEXT,
        provenance_json TEXT,
        source_revision TEXT,
        algorithm_version TEXT,
        source_span_start INTEGER,
        source_span_end INTEGER,
        target_anchor TEXT,
        status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'stale', 'rejected')),
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_relations_from
        ON memory_relations(from_key, active, status);
    CREATE INDEX IF NOT EXISTS idx_memory_relations_to
        ON memory_relations(to_key, active, status);
    CREATE INDEX IF NOT EXISTS idx_memory_relations_origin
        ON memory_relations(origin, status, updated_at);
`;

const METADATA_GENERATION_KEY = "memoria.metadata_generation";
const VECTOR_GENERATION_KEY = "memoria.vector_generation";
const VECTOR_DIRTY_KEY = "memoria.vector_dirty";
const RELATION_GENERATION_KEY = "memoria.relation_generation";

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

    if (this.dbPath !== ":memory:" && !this.dbPath.startsWith("file:")) {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    }
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
    const additiveMigrations: Array<[string, string, string]> = [
      ["tag_intrinsic_residuals", "raw_residual_ratio", "REAL"],
      ["tag_intrinsic_residuals", "v8_3_compat_gain", "REAL"],
      ["tag_intrinsic_residuals", "v9_anchor_gain", "REAL"],
      ["tag_intrinsic_residuals", "model_sig", "TEXT"],
      ["tag_intrinsic_residuals", "artifact_sig", "TEXT"],
      ["tag_intrinsic_residuals", "algorithm_version", "TEXT"],
      ["tag_intrinsic_residuals", "config_hash", "TEXT"],
      ["tag_intrinsic_residuals", "status", "TEXT NOT NULL DEFAULT 'computed'"],
      ["rivermemo_artifacts", "payload_codec", "TEXT NOT NULL DEFAULT 'gzip-json-v1'"],
      ["rivermemo_artifacts", "payload_checksum", "TEXT"],
      ["rivermemo_artifacts", "payload", "BLOB"],
      ["rivermemo_artifacts", "status", "TEXT NOT NULL DEFAULT 'ready'"],
      ["rivermemo_artifacts", "error_message", "TEXT"],
      ["rivermemo_artifacts", "node_count", "INTEGER NOT NULL DEFAULT 0"],
      ["rivermemo_artifacts", "edge_count", "INTEGER NOT NULL DEFAULT 0"],
      ["rivermemo_artifacts", "published_at", "INTEGER"],
    ];
    for (const [table, name, definition] of additiveMigrations) {
      const tableColumns = this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{
        name: string;
      }>;
      if (!tableColumns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_files_diary ON files(diary_name);
      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
      CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);
      CREATE INDEX IF NOT EXISTS idx_file_tags_composite ON file_tags(tag_id, file_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_files_document_id
        ON files(document_id) WHERE document_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_intrinsic_residual_artifact
        ON tag_intrinsic_residuals(artifact_sig);
      CREATE INDEX IF NOT EXISTS idx_intrinsic_residual_model
        ON tag_intrinsic_residuals(model_sig);
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
    this.db
      .prepare("INSERT OR IGNORE INTO kv_store (key, value) VALUES (?, ?)")
      .run(RELATION_GENERATION_KEY, "0");
  }

  _incrementMetadataGenerationInTransaction(vectorStateChanged = true): number {
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
    if (vectorStateChanged) {
      setKv.run(VECTOR_DIRTY_KEY, "1");
    } else {
      const dirtyRow = this.db
        .prepare("SELECT value FROM kv_store WHERE key = ?")
        .get(VECTOR_DIRTY_KEY) as KeyValueRow | undefined;
      if ((dirtyRow?.value ?? "1") === "0") {
        setKv.run(VECTOR_GENERATION_KEY, String(metadataGeneration));
        setKv.run(VECTOR_DIRTY_KEY, "0");
      }
    }
    return metadataGeneration;
  }

  _incrementRelationGenerationInTransaction(): number {
    const generationRow = this.db
      .prepare("SELECT value FROM kv_store WHERE key = ?")
      .get(RELATION_GENERATION_KEY) as KeyValueRow | undefined;
    const currentGeneration = Number.parseInt(generationRow?.value ?? "0", 10);
    const relationGeneration =
      Number.isSafeInteger(currentGeneration) && currentGeneration >= 0
        ? currentGeneration + 1
        : 1;
    this.db
      .prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)")
      .run(RELATION_GENERATION_KEY, String(relationGeneration));
    return relationGeneration;
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
    const vectorStateChanged =
      existing.diary_name !== fileMeta.diaryName ||
      existing.checksum !== fileMeta.checksum;
    this.db.transaction(() => {
      this._incrementMetadataGenerationInTransaction(vectorStateChanged);
    })();
    return { fileId: Number(existing.id), changed: true };
  }

  async replaceDocumentTags(
    replacement: DocumentTagReplacement,
  ): Promise<DocumentTagReplacementResult> {
    const { file, tags, orderedTagNames } = replacement;
    const now = Math.floor(Date.now() / 1000);

    return this.db.transaction(() => {
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

      let fileId: number;
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
        fileId = Number(existing.id);
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
      const previousTagIds = (
        this.db
          .prepare("SELECT tag_id FROM file_tags WHERE file_id = ?")
          .all(fileId) as Array<{ tag_id: number }>
      ).map((row) => Number(row.tag_id));
      for (const tagName of orderedTagNames) {
        let tagId = tagIdsByName.get(tagName);
        if (tagId === undefined) {
          const stored = selectTag.get(tagName) as
            { id: number; vector?: Buffer | null } | undefined;
          if (stored?.vector != null) tagId = Number(stored.id);
        }
        if (tagId !== undefined && !fileTagIds.includes(tagId)) {
          fileTagIds.push(tagId);
        }
      }

      this.db.prepare("DELETE FROM file_tags WHERE file_id = ?").run(fileId);
      const insertFileTag = this.db.prepare(
        "INSERT INTO file_tags (file_id, tag_id, position) VALUES (?, ?, ?)",
      );
      fileTagIds.forEach((tagId, index) => {
        insertFileTag.run(fileId, tagId, index + 1);
      });

      const metadataGeneration = this._incrementMetadataGenerationInTransaction();
      const orphanedTagIds = previousTagIds.filter((tagId) => {
        const row = this.db
          .prepare("SELECT 1 AS present FROM file_tags WHERE tag_id = ? LIMIT 1")
          .get(tagId) as { present?: number } | undefined;
        return !row?.present;
      });
      return {
        fileId,
        tagIds,
        metadataGeneration,
        previousIndexName,
        currentIndexName: file.diaryName,
        orphanedTagIds,
      };
    })();
  }

  async countFiles(): Promise<number> {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM files").get() as
      { c?: number } | undefined;
    return Number(row?.c) || 0;
  }

  async getAllFiles(): Promise<FileRow[]> {
    return this.db.prepare("SELECT * FROM files ORDER BY path ASC").all() as FileRow[];
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

  async getFileByDocumentId(documentId: string): Promise<FileRow | null> {
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
    const row = this.db
      .prepare("SELECT path, document_id FROM files WHERE id = ?")
      .get(fileId) as { path?: string; document_id?: string | null } | undefined;
    if (!row?.path) return;
    await this.deleteDocumentAuthority({
      path: row.path,
      documentId: row.document_id || undefined,
    });
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
    return this._replaceDocumentStateInternal(replacement);
  }

  async replaceDocumentAuthority(
    replacement: DocumentStateReplacement & {
      relationSourceKey: string;
      relationSourceRevision: string;
      explicitRelations: readonly MemoryRelationRecord[];
    },
  ): Promise<DocumentStateReplacementResult> {
    return this._replaceDocumentStateInternal(replacement);
  }

  private async _replaceDocumentStateInternal(
    replacement: DocumentStateReplacement,
  ): Promise<DocumentStateReplacementResult> {
    const { file, chunks, tags, orderedTagNames } = replacement;
    const preserveChunks = replacement.preserveChunks === true;
    const preserveTags = replacement.preserveTags === true;
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
      const removedChunkIds =
        existing && !preserveChunks
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

      const existingChunkIds = preserveChunks
        ? (
            this.db
              .prepare("SELECT id FROM chunks WHERE file_id = ? ORDER BY chunk_index")
              .all(fileId) as Array<{ id: number }>
          ).map((row) => Number(row.id))
        : [];
      const deleteChunks = this.db.prepare("DELETE FROM chunks WHERE file_id = ?");
      if (!preserveChunks) deleteChunks.run(fileId);
      const insertChunk = this.db.prepare(
        "INSERT INTO chunks (file_id, chunk_index, content, vector) VALUES (?, ?, ?, ?)",
      );
      const chunkIds: number[] = [...existingChunkIds];
      if (!preserveChunks) {
        for (const chunk of chunks) {
          const info = insertChunk.run(
            fileId,
            chunk.chunkIndex,
            chunk.content,
            chunk.vector ?? null,
          );
          chunkIds.push(Number(info.lastInsertRowid));
        }
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

      const previousTagIds = (
        this.db
          .prepare("SELECT tag_id FROM file_tags WHERE file_id = ?")
          .all(fileId) as Array<{ tag_id: number }>
      ).map((row) => Number(row.tag_id));
      const fileTagIds: number[] = preserveTags ? [...previousTagIds] : [];
      if (!preserveTags) {
        for (const tagName of orderedTagNames) {
          let tagId = tagIdsByName.get(tagName);
          if (tagId === undefined) {
            const stored = selectTag.get(tagName) as
              { id: number; vector?: Buffer | null } | undefined;
            if (stored?.vector != null) tagId = Number(stored.id);
          }
          if (tagId !== undefined) fileTagIds.push(tagId);
        }
      }

      if (!preserveTags) {
        this.db.prepare("DELETE FROM file_tags WHERE file_id = ?").run(fileId);
        const insertFileTag = this.db.prepare(
          "INSERT INTO file_tags (file_id, tag_id, position) VALUES (?, ?, ?)",
        );
        fileTagIds.forEach((tagId, index) => {
          insertFileTag.run(fileId, tagId, index + 1);
        });
      }

      if (replacement.relationSourceKey) {
        const relationKeys = new Set<string>([
          replacement.relationSourceKey,
          ...relationDocumentAliases({ path: replacement.file.path }),
          ...(existing ? relationDocumentAliases(existing) : []),
        ]);
        const staleRelations = this.db.prepare(
          `UPDATE memory_relations
           SET status = 'stale', active = 0, updated_at = ?
           WHERE from_key = ? AND origin = 'source' AND active = 1`,
        );
        for (const relationKey of relationKeys) {
          staleRelations.run(now * 1000, relationKey);
        }

        const insertRelation = this.db.prepare(`
          INSERT INTO memory_relations (
            id, from_key, to_key, kind, origin, confidence, weight, evidence,
            provenance_json, source_revision, algorithm_version,
            source_span_start, source_span_end, target_anchor, status, active,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'source', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            from_key = excluded.from_key,
            to_key = excluded.to_key,
            kind = excluded.kind,
            origin = 'source',
            confidence = excluded.confidence,
            weight = excluded.weight,
            evidence = excluded.evidence,
            provenance_json = excluded.provenance_json,
            source_revision = excluded.source_revision,
            algorithm_version = excluded.algorithm_version,
            source_span_start = excluded.source_span_start,
            source_span_end = excluded.source_span_end,
            target_anchor = excluded.target_anchor,
            status = 'active',
            active = 1,
            updated_at = excluded.updated_at
        `);
        for (const relation of replacement.explicitRelations ?? []) {
          insertRelation.run(
            relation.id,
            replacement.relationSourceKey,
            relation.to,
            relation.kind,
            Math.max(0, Math.min(1, Number(relation.confidence) || 0)),
            Math.max(0, Number(relation.weight) || 0),
            relation.evidence ?? null,
            relation.provenance ? JSON.stringify(relation.provenance) : null,
            replacement.relationSourceRevision ?? null,
            relation.algorithmVersion ?? null,
            relation.sourceSpan?.start ?? null,
            relation.sourceSpan?.end ?? null,
            relation.targetAnchor ?? null,
            Number(relation.createdAt) || now * 1000,
            now * 1000,
          );
        }
        this._incrementRelationGenerationInTransaction();
      }

      const vectorStateChanged =
        !preserveChunks || !preserveTags || previousIndexName !== file.diaryName;
      const metadataGeneration =
        this._incrementMetadataGenerationInTransaction(vectorStateChanged);
      const orphanedTagIds = previousTagIds.filter((tagId) => {
        const row = this.db
          .prepare("SELECT 1 AS present FROM file_tags WHERE tag_id = ? LIMIT 1")
          .get(tagId) as { present?: number } | undefined;
        return !row?.present;
      });

      return {
        fileId,
        chunkIds,
        tagIds,
        removedChunkIds,
        metadataGeneration,
        previousIndexName,
        currentIndexName: file.diaryName,
        orphanedTagIds,
      };
    })();

    return result;
  }

  async deleteDocumentAuthority(input: {
    path: string;
    documentId?: string;
    relationSourceKeys?: readonly string[];
  }): Promise<{
    removed: boolean;
    fileId: number | null;
    chunkIds: number[];
    orphanedTagIds: number[];
  }> {
    return this.db.transaction(() => {
      const existing =
        (input.documentId
          ? (this.db
              .prepare("SELECT * FROM files WHERE document_id = ?")
              .get(input.documentId) as FileQueryRow | undefined)
          : undefined) ||
        (this.db.prepare("SELECT * FROM files WHERE path = ?").get(input.path) as
          FileQueryRow | undefined);
      if (!existing) {
        return { removed: false, fileId: null, chunkIds: [], orphanedTagIds: [] };
      }

      const chunkIds = (
        this.db
          .prepare("SELECT id FROM chunks WHERE file_id = ? ORDER BY id")
          .all(existing.id) as Array<{ id: number }>
      ).map((row) => Number(row.id));
      const tagIds = (
        this.db
          .prepare("SELECT tag_id FROM file_tags WHERE file_id = ?")
          .all(existing.id) as Array<{ tag_id: number }>
      ).map((row) => Number(row.tag_id));

      const relationKeys = new Set<string>([
        ...relationDocumentAliases(existing),
        ...(input.relationSourceKeys || []),
      ]);
      const staleRelations = this.db.prepare(
        `UPDATE memory_relations
         SET status = 'stale', active = 0, updated_at = ?
         WHERE from_key = ? AND origin = 'source' AND active = 1`,
      );
      for (const relationKey of relationKeys) {
        staleRelations.run(Date.now(), relationKey);
      }
      if (relationKeys.size > 0) this._incrementRelationGenerationInTransaction();

      this.db.prepare("DELETE FROM file_tags WHERE file_id = ?").run(existing.id);
      this.db.prepare("DELETE FROM chunks WHERE file_id = ?").run(existing.id);
      this.db.prepare("DELETE FROM files WHERE id = ?").run(existing.id);
      const orphanedTagIds = tagIds.filter((tagId) => {
        const row = this.db
          .prepare("SELECT 1 AS present FROM file_tags WHERE tag_id = ? LIMIT 1")
          .get(tagId) as { present?: number } | undefined;
        return !row?.present;
      });
      this._incrementMetadataGenerationInTransaction();
      return { removed: true, fileId: existing.id, chunkIds, orphanedTagIds };
    })();
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

  async getSearchCorpus(indexNames?: readonly string[]): Promise<SearchCorpusChunk[]> {
    if (Array.isArray(indexNames) && indexNames.length === 0) return [];
    let sql = `
      SELECT c.id, c.content, f.diary_name AS index_name
      FROM chunks c
      JOIN files f ON f.id = c.file_id`;
    const params: string[] = [];
    if (Array.isArray(indexNames) && indexNames.length > 0) {
      const placeholders = indexNames.map(() => "?").join(", ");
      sql += ` WHERE f.diary_name IN (${placeholders})`;
      params.push(...indexNames.map(String));
    }
    sql += " ORDER BY c.id";
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number;
      content: string;
      index_name: string;
    }>;
    return rows.map((row) => ({
      id: Number(row.id),
      content: row.content,
      indexName: row.index_name,
    }));
  }

  async resolveRetrievalScope(
    filters: RetrievalScopeFilters,
    indexNames?: readonly string[],
  ): Promise<RetrievalScopeResolution> {
    if (Array.isArray(filters.spaces) && filters.spaces.length === 0) {
      return { allowedChunkIds: [], allowedDocumentKeys: [] };
    }
    if (Array.isArray(indexNames) && indexNames.length === 0) {
      return { allowedChunkIds: [], allowedDocumentKeys: [] };
    }

    const where: string[] = [];
    const params: unknown[] = [];
    const spaces = filters.spaces ?? indexNames;
    if (spaces && spaces.length > 0) {
      where.push(`f.diary_name IN (${spaces.map(() => "?").join(", ")})`);
      params.push(...spaces.map(String));
    }
    if (filters.documentIds && filters.documentIds.length === 0) {
      return { allowedChunkIds: [], allowedDocumentKeys: [] };
    }
    if (filters.documentIds && filters.documentIds.length > 0) {
      where.push(`f.document_id IN (${filters.documentIds.map(() => "?").join(", ")})`);
      params.push(...filters.documentIds.map(String));
    }
    const after = scopeEpochSeconds(filters.recordedAfter);
    const before = scopeEpochSeconds(filters.recordedBefore);
    if (after !== null) {
      where.push("COALESCE(f.updated_at, f.mtime) >= ?");
      params.push(after);
    }
    if (before !== null) {
      where.push("COALESCE(f.updated_at, f.mtime) <= ?");
      params.push(before);
    }

    const rows = this.db
      .prepare(
        `SELECT c.id AS chunk_id, f.path, f.document_id, f.metadata_json
         FROM chunks c
         JOIN files f ON f.id = c.file_id
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY c.id`,
      )
      .all(...params) as Array<{
      chunk_id: number;
      path: string;
      document_id?: string | null;
      metadata_json?: string | null;
    }>;
    const allowedChunkIds: number[] = [];
    const allowedDocumentKeys = new Set<string>();
    for (const row of rows) {
      if (
        filters.metadata &&
        !matchesMetadataJson(row.metadata_json, filters.metadata)
      ) {
        continue;
      }
      allowedChunkIds.push(Number(row.chunk_id));
      for (const key of relationDocumentAliases({
        documentId: row.document_id,
        path: row.path,
      })) {
        allowedDocumentKeys.add(key);
      }
    }
    return { allowedChunkIds, allowedDocumentKeys: [...allowedDocumentKeys] };
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
          `SELECT DISTINCT f.diary_name
           FROM files f
           JOIN chunks c ON c.file_id = f.id
           WHERE f.diary_name IS NOT NULL
             AND f.diary_name != ''
             AND c.vector IS NOT NULL
           ORDER BY f.diary_name`,
        )
        .all() as Array<{ diary_name?: string | null }>
    )
      .map((row) => row.diary_name || "")
      .filter(Boolean);
    const tagRow = this.db
      .prepare(
        `SELECT 1 AS present
         FROM tags t
         JOIN file_tags ft ON ft.tag_id = t.id
         WHERE t.vector IS NOT NULL
         LIMIT 1`,
      )
      .get() as { present?: number } | undefined;
    if (tagRow?.present) names.push("global_tags");
    return [...new Set(names)].sort((left, right) => left.localeCompare(right));
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

  async getActiveTags(): Promise<TagRow[]> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT t.id, t.name, t.vector
         FROM tags t
         JOIN file_tags ft ON ft.tag_id = t.id
         ORDER BY t.id`,
      )
      .all();
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

  /**
   * Replace the active source edges for one immutable source revision while
   * retaining older revisions as stale audit records. This is deliberately a
   * separate generation from vector state: changing a relation invalidates
   * Memo artifacts, but does not require rebuilding ordinary chunk vectors.
   */
  async replaceExplicitRelations(
    from: string,
    sourceRevision: string,
    relations: readonly MemoryRelationRecord[],
  ): Promise<void> {
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE memory_relations
           SET status = 'stale', active = 0, updated_at = ?
           WHERE from_key = ? AND origin = 'source' AND active = 1`,
        )
        .run(now, from);

      const insert = this.db.prepare(`
        INSERT INTO memory_relations (
          id, from_key, to_key, kind, origin, confidence, weight, evidence,
          provenance_json, source_revision, algorithm_version,
          source_span_start, source_span_end, target_anchor, status, active,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'source', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          from_key = excluded.from_key,
          to_key = excluded.to_key,
          kind = excluded.kind,
          origin = 'source',
          confidence = excluded.confidence,
          weight = excluded.weight,
          evidence = excluded.evidence,
          provenance_json = excluded.provenance_json,
          source_revision = excluded.source_revision,
          algorithm_version = excluded.algorithm_version,
          source_span_start = excluded.source_span_start,
          source_span_end = excluded.source_span_end,
          target_anchor = excluded.target_anchor,
          status = 'active',
          active = 1,
          updated_at = excluded.updated_at
      `);

      for (const relation of relations) {
        const confidence = Math.max(0, Math.min(1, Number(relation.confidence) || 0));
        const weight = Math.max(0, Number(relation.weight) || 0);
        const provenance = relation.provenance
          ? JSON.stringify(relation.provenance)
          : null;
        insert.run(
          relation.id,
          from,
          relation.to,
          relation.kind,
          confidence,
          weight,
          relation.evidence ?? null,
          provenance,
          sourceRevision,
          relation.algorithmVersion ?? null,
          relation.sourceSpan?.start ?? null,
          relation.sourceSpan?.end ?? null,
          relation.targetAnchor ?? null,
          Number(relation.createdAt) || now,
          now,
        );
      }
      this._incrementRelationGenerationInTransaction();
    })();
  }

  async upsertDerivedRelations(
    relations: readonly (Omit<
      MemoryRelationRecord,
      "id" | "origin" | "createdAt" | "updatedAt" | "status"
    > &
      Partial<
        Pick<
          MemoryRelationRecord,
          "id" | "origin" | "createdAt" | "updatedAt" | "status"
        >
      >)[],
  ): Promise<void> {
    if (relations.length === 0) return;
    const now = Date.now();
    this.db.transaction(() => {
      const find = this.db.prepare("SELECT * FROM memory_relations WHERE id = ?");
      const insert = this.db.prepare(`
        INSERT INTO memory_relations (
          id, from_key, to_key, kind, origin, confidence, weight, evidence,
          provenance_json, source_revision, algorithm_version,
          source_span_start, source_span_end, target_anchor, status, active,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'derived', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          from_key = excluded.from_key,
          to_key = excluded.to_key,
          kind = excluded.kind,
          origin = 'derived',
          confidence = excluded.confidence,
          weight = excluded.weight,
          evidence = excluded.evidence,
          provenance_json = excluded.provenance_json,
          source_revision = excluded.source_revision,
          algorithm_version = excluded.algorithm_version,
          source_span_start = excluded.source_span_start,
          source_span_end = excluded.source_span_end,
          target_anchor = excluded.target_anchor,
          status = excluded.status,
          active = excluded.active,
          updated_at = excluded.updated_at
      `);

      for (const relation of relations) {
        const id =
          relation.id || relationInputId(relation.from, relation.to, relation.kind);
        const previous = find.get(id) as RelationQueryRow | undefined;
        const requestedStatus: MemoryRelationStatus =
          relation.status === "rejected"
            ? "rejected"
            : !(relation.active ?? true) || relation.status === "stale"
              ? "stale"
              : "active";
        const confidence = Math.max(0, Math.min(1, Number(relation.confidence) || 0));
        if (
          previous &&
          requestedStatus === "active" &&
          previous.status === "active" &&
          confidence < Number(previous.confidence)
        ) {
          continue;
        }
        const provenance = relation.provenance
          ? JSON.stringify(relation.provenance)
          : null;
        insert.run(
          id,
          relation.from,
          relation.to,
          relation.kind,
          confidence,
          Math.max(0, Number(relation.weight) || 0),
          relation.evidence ?? null,
          provenance,
          relation.sourceRevision ?? null,
          relation.algorithmVersion ?? null,
          relation.sourceSpan?.start ?? null,
          relation.sourceSpan?.end ?? null,
          relation.targetAnchor ?? null,
          requestedStatus,
          requestedStatus === "active" ? 1 : 0,
          Number(relation.createdAt) || previous?.created_at || now,
          now,
        );
      }
      this._incrementRelationGenerationInTransaction();
    })();
  }

  async listRelations(
    options: RelationListOptions = {},
  ): Promise<MemoryRelationRecord[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (options.includeInactive !== true) {
      where.push("active = 1", "status = 'active'");
    }
    if (options.from !== undefined) {
      where.push("from_key = ?");
      values.push(options.from);
    }
    if (options.to !== undefined) {
      where.push("to_key = ?");
      values.push(options.to);
    }
    if (options.origins && options.origins.length > 0) {
      where.push(`origin IN (${options.origins.map(() => "?").join(",")})`);
      values.push(...options.origins);
    }
    if (options.kinds && options.kinds.length > 0) {
      where.push(`kind IN (${options.kinds.map(() => "?").join(",")})`);
      values.push(...options.kinds);
    }
    if (options.statuses && options.statuses.length > 0) {
      where.push(`status IN (${options.statuses.map(() => "?").join(",")})`);
      values.push(...options.statuses);
    }
    const sql = `SELECT * FROM memory_relations${
      where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
    } ORDER BY updated_at ASC, id ASC`;
    const rows = this.db.prepare(sql).all(...values) as RelationQueryRow[];
    return rows.map(relationFromRow);
  }

  async getRelationReadinessStats(): Promise<{
    explicitLinks: number;
    activeInferredLinks: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT origin, COUNT(*) AS count
         FROM memory_relations
         WHERE active = 1 AND status = 'active'
         GROUP BY origin`,
      )
      .all() as Array<{ origin: string; count: number }>;
    return {
      explicitLinks: Number(rows.find((row) => row.origin === "source")?.count) || 0,
      activeInferredLinks:
        Number(rows.find((row) => row.origin === "derived")?.count) || 0,
    };
  }

  async getAdjacentRelations(
    documentKeys: readonly string[],
  ): Promise<MemoryRelationRecord[]> {
    const keys = [...new Set(documentKeys.map(String).filter(Boolean))];
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_relations
         WHERE active = 1 AND status = 'active'
           AND (from_key IN (${placeholders}) OR to_key IN (${placeholders}))
         ORDER BY updated_at ASC, id ASC`,
      )
      .all(...keys, ...keys) as RelationQueryRow[];
    return rows.map(relationFromRow);
  }

  async markExplicitRelationsStale(from: string): Promise<void> {
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE memory_relations
           SET status = 'stale', active = 0, updated_at = ?
           WHERE from_key = ? AND origin = 'source' AND active = 1`,
        )
        .run(Date.now(), from);
      if (Number(result.changes) > 0) this._incrementRelationGenerationInTransaction();
    })();
  }

  async getRelationGeneration(): Promise<number> {
    const value = await this.getKv(RELATION_GENERATION_KEY);
    const parsed = Number.parseInt(value ?? "0", 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

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
