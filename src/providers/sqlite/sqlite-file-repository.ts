import type BetterSqlite3 from "better-sqlite3";

import type { FileMetadataInput, FileRow } from "../../types/metadata.js";

export interface FileQueryRow {
  id: number;
  path: string;
  space: string;
  checksum: string;
  mtime: number;
  size: number;
  updated_at?: number | null;
  document_id?: string | null;
  revision?: string | null;
  source_json?: string | null;
  metadata_json?: string | null;
}

export type RunTransaction<T> = (task: () => T) => T;

/** SQL operations whose aggregate root is a file. */
export default class SqliteFileRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  upsertFile(fileMeta: FileMetadataInput): number | null {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      INSERT INTO files (
        path, space, checksum, mtime, size, updated_at,
        document_id, revision, source_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        space = excluded.space,
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
      fileMeta.space,
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

  updateDocumentMetadata(
    fileMeta: FileMetadataInput,
    incrementGeneration: (vectorStateChanged: boolean) => void,
    transaction: RunTransaction<void>,
  ): { fileId: number; changed: boolean } {
    const existing = this.db
      .prepare("SELECT * FROM files WHERE path = ?")
      .get(fileMeta.path) as FileQueryRow | undefined;
    if (!existing) {
      const fileId = this.upsertFile(fileMeta);
      if (fileId == null) throw new Error("Unable to persist file metadata");
      return { fileId, changed: true };
    }

    const changed =
      existing.space !== fileMeta.space ||
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
          space = ?, checksum = ?, mtime = ?, size = ?, updated_at = ?,
          document_id = ?, revision = ?, source_json = ?, metadata_json = ?
         WHERE id = ?`,
      )
      .run(
        fileMeta.space,
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
    transaction(() => {
      incrementGeneration(
        existing.space !== fileMeta.space || existing.checksum !== fileMeta.checksum,
      );
    });
    return { fileId: Number(existing.id), changed: true };
  }

  findFile(
    file: Pick<FileMetadataInput, "path" | "documentId">,
  ): FileQueryRow | undefined {
    if (file.documentId) {
      const byDocument = this.db
        .prepare("SELECT * FROM files WHERE document_id = ?")
        .get(file.documentId) as FileQueryRow | undefined;
      if (byDocument) return byDocument;
    }
    return this.db.prepare("SELECT * FROM files WHERE path = ?").get(file.path) as
      FileQueryRow | undefined;
  }

  upsertFileRow(
    file: FileMetadataInput,
    existing: FileQueryRow | undefined,
    now: number,
  ): number {
    const values = [
      file.path,
      file.space,
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
            path = ?, space = ?, checksum = ?, mtime = ?, size = ?,
            updated_at = ?, document_id = ?, revision = ?, source_json = ?,
            metadata_json = ? WHERE id = ?`,
        )
        .run(...values, existing.id);
      return Number(existing.id);
    }
    const info = this.db
      .prepare(
        `INSERT INTO files (
          path, space, checksum, mtime, size, updated_at,
          document_id, revision, source_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...values);
    return Number(info.lastInsertRowid);
  }

  findByPath(filePath: string): FileRow | null {
    return (
      (this.db.prepare("SELECT * FROM files WHERE path = ?").get(filePath) as
        FileQueryRow | undefined) || null
    );
  }

  findByDocumentId(documentId: string): FileRow | null {
    return (
      (this.db.prepare("SELECT * FROM files WHERE document_id = ?").get(documentId) as
        FileQueryRow | undefined) || null
    );
  }

  listFiles(): FileRow[] {
    return this.db.prepare("SELECT * FROM files ORDER BY path ASC").all() as FileRow[];
  }

  countFiles(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM files").get() as
      { c?: number } | undefined;
    return Number(row?.c) || 0;
  }

  getLastIndexedAt(): number | null {
    const row = this.db.prepare("SELECT MAX(updated_at) AS m FROM files").get() as
      { m?: number | null } | undefined;
    return row?.m == null ? null : Number(row.m) * 1000;
  }

  listSpaces(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT space FROM files WHERE space != ?")
      .all("");
    return (rows as Array<{ space?: string }>)
      .map((row) => row.space || "")
      .filter(Boolean);
  }

  fileByChunkId(chunkId: number): FileRow | null {
    return (
      (this.db
        .prepare(
          "SELECT f.* FROM chunks c JOIN files f ON c.file_id = f.id WHERE c.id = ?",
        )
        .get(chunkId) as FileQueryRow | undefined) || null
    );
  }

  findById(fileId: number): FileQueryRow | undefined {
    return this.db.prepare("SELECT * FROM files WHERE id = ?").get(fileId) as
      FileQueryRow | undefined;
  }
}
