"use strict";

import MetadataStore from "../interfaces/metadata-store.js";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
  HealthStatus,
  IndexableChunkRow,
  RetrievalScopeFilters,
  RetrievalScopeResolution,
  TagMetadataInput,
  TagRow,
} from "../types/metadata.js";
import type { MemoryRelationRecord, RelationListOptions } from "../types/relations.js";
import type {
  PropagationHistoryObservation,
  PropagationHistorySnapshot,
} from "../types/retrieval.js";
import type { SearchCorpusChunk } from "../types/vector.js";
import SqliteAuthorityRepository from "./sqlite/authority-repository.js";
import SqliteHealthRepository from "./sqlite/sqlite-health-repository.js";
import SqliteMetadataRepository from "./sqlite/metadata-repository.js";
import SqliteRetrievalRepository from "./sqlite/retrieval-repository.js";
import SqliteRelationRepository from "./sqlite/relation-repository.js";
import SqliteSchemaManager from "./sqlite/sqlite-schema-manager.js";
import SqliteStateRepository from "./sqlite/sqlite-state-repository.js";
import SqlitePropagationHistoryRepository from "./sqlite/sqlite-propagation-history-repository.js";

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

interface SqliteConfig {
  dbPath?: string;
  dimension?: number;
  busyTimeout?: number;
  busyRetryDelay?: number;
}

/**
 * SQLite-backed metadata store using better-sqlite3.
 *
 * Consolidates schema initialization, file/chunk/tag CRUD, co-occurrence
 * matrix building, and health-check logic for the canonical metadata schema.
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
  private readonly metadata: SqliteMetadataRepository;
  private readonly retrieval: SqliteRetrievalRepository;
  private readonly relations: SqliteRelationRepository;
  private readonly authority: SqliteAuthorityRepository;
  private readonly state: SqliteStateRepository;
  private readonly propagationHistory: SqlitePropagationHistoryRepository;
  private readonly health: SqliteHealthRepository;
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
    const schema = new SqliteSchemaManager(this.db, { busyTimeout: this.busyTimeout });
    schema.configureConnection();
    schema.initialize();
    this.state = new SqliteStateRepository(this.db);
    this.state.initializeDefaults();
    this.propagationHistory = new SqlitePropagationHistoryRepository(this.db);
    this.health = new SqliteHealthRepository(this.db);
    this.metadata = new SqliteMetadataRepository(this.db);
    this.retrieval = new SqliteRetrievalRepository(this.db);
    this.relations = new SqliteRelationRepository(
      this.db,
      () => this._incrementRelationGenerationInTransaction(),
      (key) => this.getKv(key),
    );
    this.authority = new SqliteAuthorityRepository({
      db: this.db,
      metadata: this.metadata,
      relations: this.relations,
      incrementMetadataGeneration: (vectorStateChanged) =>
        this._incrementMetadataGenerationInTransaction(vectorStateChanged),
    });
  }

  _incrementMetadataGenerationInTransaction(vectorStateChanged = true): number {
    return this.state.incrementMetadataGeneration(vectorStateChanged);
  }

  _incrementRelationGenerationInTransaction(): number {
    return this.state.incrementRelationGeneration();
  }

  // ── File CRUD ───────────────────────────────────────────────

  override async upsertFile(fileMeta: FileMetadataInput): Promise<number | null> {
    return this.metadata.upsertFile(fileMeta);
  }

  async updateDocumentMetadata(
    fileMeta: FileMetadataInput,
  ): Promise<{ fileId: number; changed: boolean }> {
    return this.metadata.updateDocumentMetadata(
      fileMeta,
      (vectorStateChanged) => {
        this._incrementMetadataGenerationInTransaction(vectorStateChanged);
      },
      (task) => this.db.transaction(task)(),
    );
  }

  async replaceDocumentTags(
    replacement: DocumentTagReplacement,
  ): Promise<DocumentTagReplacementResult> {
    return this.authority.replaceDocumentTags(replacement);
  }

  override async countFiles(): Promise<number> {
    return this.metadata.countFiles();
  }

  async getAllFiles(): Promise<FileRow[]> {
    return this.metadata.listFiles();
  }

  async getLastIndexedAt(): Promise<number | null> {
    return this.metadata.getLastIndexedAt();
  }

  override async getFileByPath(path: string): Promise<FileRow | null> {
    return this.metadata.findByPath(path);
  }

  async getFileByDocumentId(documentId: string): Promise<FileRow | null> {
    return this.metadata.findByDocumentId(documentId);
  }

  override async getDistinctSpaces(): Promise<string[]> {
    return this.metadata.listSpaces();
  }

  override async getFileByChunkId(chunkId: number): Promise<FileRow | null> {
    return this.metadata.fileByChunkId(chunkId);
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
    return this.metadata.insertChunks(fileId, chunks);
  }

  override async replaceDocumentState(
    replacement: DocumentStateReplacement,
  ): Promise<DocumentStateReplacementResult> {
    return this.authority.replaceDocumentState(replacement);
  }

  async replaceDocumentAuthority(
    replacement: DocumentStateReplacement & {
      relationSourceKey: string;
      relationSourceRevision: string;
      explicitRelations: readonly MemoryRelationRecord[];
    },
  ): Promise<DocumentStateReplacementResult> {
    return this.authority.replaceDocumentAuthority(replacement);
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
    return this.authority.deleteDocumentAuthority(input);
  }

  override async getChunksByFileId(fileId: number): Promise<ChunkRow[]> {
    return this.metadata.getChunksByFileId(fileId);
  }

  override async getChunkById(id: number): Promise<ChunkRow | null> {
    return this.metadata.getChunkById(id);
  }

  override async getAllChunks(): Promise<ChunkRow[]> {
    return this.metadata.getAllChunks();
  }

  async getSearchCorpus(indexNames?: readonly string[]): Promise<SearchCorpusChunk[]> {
    return this.retrieval.getSearchCorpus(indexNames);
  }

  async resolveRetrievalScope(
    filters: RetrievalScopeFilters,
    indexNames?: readonly string[],
  ): Promise<RetrievalScopeResolution> {
    return this.retrieval.resolveScope(filters, indexNames);
  }

  async getIndexableChunks(): Promise<IndexableChunkRow[]> {
    return this.retrieval.getIndexableChunks();
  }

  async getExpectedVectorIndexNames(): Promise<string[]> {
    return this.metadata.expectedIndexNames();
  }

  // ── Tag CRUD ────────────────────────────────────────────────

  override async upsertTags(tags: readonly TagMetadataInput[]): Promise<number[]> {
    return this.metadata.upsertTags(tags);
  }

  override async getTagByName(name: string): Promise<TagRow | null> {
    return this.metadata.getTagByName(name);
  }

  override async getAllTags(): Promise<TagRow[]> {
    return this.metadata.getAllTags();
  }

  async getActiveTags(): Promise<TagRow[]> {
    return this.metadata.getActiveTags();
  }

  // ── File-Tag associations ───────────────────────────────────

  override async setFileTags(fileId: number, tagIds: readonly number[]): Promise<void> {
    this.metadata.setFileTags(fileId, tagIds);
  }

  override async getFileTags(fileId: number): Promise<FileTagRow[]> {
    return this.metadata.getFileTags(fileId);
  }

  override async getFileIdsByTagId(tagId: number): Promise<number[]> {
    return this.metadata.getFileIdsByTagId(tagId);
  }

  // ── Co-occurrence ───────────────────────────────────────────

  override async buildCooccurrenceMatrix(): Promise<Map<number, Map<number, number>>> {
    return this.metadata.buildCooccurrenceMatrix();
  }

  // ── KV store ────────────────────────────────────────────────

  async replaceExplicitRelations(
    from: string,
    sourceRevision: string,
    relations: readonly MemoryRelationRecord[],
  ): Promise<void> {
    return this.relations.replaceExplicitRelations(from, sourceRevision, relations);
  }

  async upsertDerivedRelations(
    relations: Parameters<SqliteRelationRepository["upsertDerivedRelations"]>[0],
  ): Promise<void> {
    return this.relations.upsertDerivedRelations(relations);
  }

  async listRelations(
    options: RelationListOptions = {},
  ): Promise<MemoryRelationRecord[]> {
    return this.relations.listRelations(options);
  }

  async getRelationReadinessStats(): Promise<{
    explicitLinks: number;
    activeInferredLinks: number;
  }> {
    return this.relations.getRelationReadinessStats();
  }

  async getAdjacentRelations(
    documentKeys: readonly string[],
  ): Promise<MemoryRelationRecord[]> {
    return this.relations.getAdjacentRelations(documentKeys);
  }

  async markExplicitRelationsStale(from: string): Promise<void> {
    return this.relations.markExplicitRelationsStale(from);
  }

  async getRelationGeneration(): Promise<number> {
    return this.relations.getRelationGeneration();
  }
  async getKv(key: string): Promise<string | null> {
    return this.state.get(key);
  }

  async setKv(key: string, value: string): Promise<void> {
    this.state.set(key, value);
  }

  async readPropagationHistory(
    nodeIds: readonly number[],
  ): Promise<PropagationHistorySnapshot> {
    return this.propagationHistory.read(nodeIds);
  }

  async commitPropagationObservation(
    observation: PropagationHistoryObservation,
  ): Promise<PropagationHistorySnapshot> {
    return this.propagationHistory.commit(observation);
  }

  async getGenerationState(): Promise<GenerationState> {
    return this.state.getGenerationState();
  }

  async markVectorStateClean(): Promise<void> {
    this.state.markVectorStateClean();
  }

  // ── Health ──────────────────────────────────────────────────

  override async checkpoint(): Promise<void> {
    this.health.checkpoint();
  }

  override async healthCheck(): Promise<HealthStatus> {
    return this.health.healthCheck();
  }

  // ── Lifecycle ───────────────────────────────────────────────

  close(): void {
    if (this._closed) return;
    this.db.close();
    this._closed = true;
  }
}

export default SqliteMetadataStore;
