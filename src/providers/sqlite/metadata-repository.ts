import type BetterSqlite3 from "better-sqlite3";

import type {
  ChunkMetadataInput,
  ChunkRow,
  FileMetadataInput,
  FileRow,
  FileTagRow,
  TagMetadataInput,
  TagRow,
} from "../../types/metadata.js";
import SqliteChunkRepository from "./sqlite-chunk-repository.js";
import SqliteFileRepository, {
  type FileQueryRow,
  type RunTransaction,
} from "./sqlite-file-repository.js";
import SqliteGraphRepository from "./sqlite-graph-repository.js";
import SqliteIndexCatalog from "./sqlite-index-catalog.js";
import SqliteTagRepository from "./sqlite-tag-repository.js";

export type { FileQueryRow } from "./sqlite-file-repository.js";
export type { RunTransaction } from "./sqlite-file-repository.js";

/** Compatibility facade over table-focused SQLite repositories. */
export default class SqliteMetadataRepository {
  private readonly files: SqliteFileRepository;
  private readonly chunks: SqliteChunkRepository;
  private readonly tags: SqliteTagRepository;
  private readonly graph: SqliteGraphRepository;
  private readonly indexCatalog: SqliteIndexCatalog;

  constructor(db: BetterSqlite3.Database) {
    this.files = new SqliteFileRepository(db);
    this.chunks = new SqliteChunkRepository(db);
    this.tags = new SqliteTagRepository(db);
    this.graph = new SqliteGraphRepository(db);
    this.indexCatalog = new SqliteIndexCatalog(db);
  }

  upsertFile(fileMeta: FileMetadataInput): number | null {
    return this.files.upsertFile(fileMeta);
  }

  updateDocumentMetadata(
    fileMeta: FileMetadataInput,
    incrementGeneration: (vectorStateChanged: boolean) => void,
    transaction: RunTransaction<void>,
  ): { fileId: number; changed: boolean } {
    return this.files.updateDocumentMetadata(
      fileMeta,
      incrementGeneration,
      transaction,
    );
  }

  findFile(
    file: Pick<FileMetadataInput, "path" | "documentId">,
  ): FileQueryRow | undefined {
    return this.files.findFile(file);
  }

  upsertFileRow(file: FileMetadataInput, existing: FileQueryRow | undefined): number {
    return this.files.upsertFileRow(file, existing);
  }

  findByPath(filePath: string): FileRow | null {
    return this.files.findByPath(filePath);
  }

  findByDocumentId(documentId: string): FileRow | null {
    return this.files.findByDocumentId(documentId);
  }

  listFiles(): FileRow[] {
    return this.files.listFiles();
  }

  countFiles(): number {
    return this.files.countFiles();
  }

  getLastIndexedAt(): number | null {
    return this.files.getLastIndexedAt();
  }

  listSpaces(): string[] {
    return this.files.listSpaces();
  }

  fileByChunkId(chunkId: number): FileRow | null {
    return this.files.fileByChunkId(chunkId);
  }

  findFileById(fileId: number): FileQueryRow | undefined {
    return this.files.findById(fileId);
  }

  insertChunks(fileId: number, chunks: readonly ChunkMetadataInput[]): number[] {
    return this.chunks.insertChunks(fileId, chunks);
  }

  deleteChunks(fileId: number): void {
    this.chunks.deleteChunks(fileId);
  }

  insertChunksInTransaction(
    fileId: number,
    chunks: readonly ChunkMetadataInput[],
  ): number[] {
    return this.chunks.insertChunksInTransaction(fileId, chunks);
  }

  getChunksByFileId(fileId: number): ChunkRow[] {
    return this.chunks.getChunksByFileId(fileId);
  }

  getChunkIdsByFileId(fileId: number, orderBy: "id" | "chunk_index" = "id"): number[] {
    return this.chunks.getChunkIdsByFileId(fileId, orderBy);
  }

  getChunkById(id: number): ChunkRow | null {
    return this.chunks.getChunkById(id);
  }

  getAllChunks(): ChunkRow[] {
    return this.chunks.getAllChunks();
  }

  upsertTags(tags: readonly TagMetadataInput[]): number[] {
    return this.tags.upsertTags(tags);
  }

  upsertTagsInTransaction(tags: readonly TagMetadataInput[]): {
    tagIds: number[];
    tagIdsByName: Map<string, number>;
  } {
    return this.tags.upsertTagsInTransaction(tags);
  }

  findTagIdWithVector(name: string): number | undefined {
    return this.tags.findTagIdWithVector(name);
  }

  getFileTagIds(fileId: number): number[] {
    return this.tags.getFileTagIds(fileId);
  }

  replaceFileTagRows(fileId: number, tagIds: readonly number[]): void {
    this.tags.replaceFileTagRows(fileId, tagIds);
  }

  findOrphanedTagIds(tagIds: readonly number[]): number[] {
    return this.tags.findOrphanedTagIds(tagIds);
  }

  getTagByName(name: string): TagRow | null {
    return this.tags.getTagByName(name);
  }

  getAllTags(): TagRow[] {
    return this.tags.getAllTags();
  }

  getActiveTags(): TagRow[] {
    return this.tags.getActiveTags();
  }

  setFileTags(fileId: number, tagIds: readonly number[]): void {
    this.tags.setFileTags(fileId, tagIds);
  }

  getFileTags(fileId: number): FileTagRow[] {
    return this.tags.getFileTags(fileId);
  }

  getFileIdsByTagId(tagId: number): number[] {
    return this.tags.getFileIdsByTagId(tagId);
  }

  buildCooccurrenceMatrix(): Map<number, Map<number, number>> {
    return this.graph.buildCooccurrenceMatrix();
  }

  expectedIndexNames(): string[] {
    return this.indexCatalog.expectedIndexNames();
  }
}
