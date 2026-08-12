import type BetterSqlite3 from "better-sqlite3";

import type { ChunkMetadataInput, ChunkRow } from "../../types/metadata.js";

interface ChunkQueryRow {
  id: number;
  file_id: number;
  chunk_index: number;
  content: string;
  vector?: Buffer | null;
}

/** SQL operations for the file chunk collection. */
export default class SqliteChunkRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  insertChunks(fileId: number, chunks: readonly ChunkMetadataInput[]): number[] {
    return this.db.transaction(() => {
      this.deleteChunks(fileId);
      return this.insertChunksInTransaction(fileId, chunks);
    })();
  }

  deleteChunks(fileId: number): void {
    this.db.prepare("DELETE FROM chunks WHERE file_id = ?").run(fileId);
  }

  insertChunksInTransaction(
    fileId: number,
    chunks: readonly ChunkMetadataInput[],
  ): number[] {
    const insert = this.db.prepare(
      "INSERT INTO chunks (file_id, chunk_index, content, vector) VALUES (?, ?, ?, ?)",
    );
    return chunks.map((chunk) => {
      const info = insert.run(
        fileId,
        chunk.chunkIndex,
        chunk.content,
        chunk.vector || null,
      );
      return Number(info.lastInsertRowid);
    });
  }

  getChunksByFileId(fileId: number): ChunkRow[] {
    const rows = this.db
      .prepare(
        "SELECT id, file_id, chunk_index, content, vector FROM chunks WHERE file_id = ? ORDER BY chunk_index",
      )
      .all(fileId) as ChunkQueryRow[];
    return rows.map(toChunkRow);
  }

  getChunkIdsByFileId(fileId: number, orderBy: "id" | "chunk_index" = "id"): number[] {
    const rows = this.db
      .prepare(`SELECT id FROM chunks WHERE file_id = ? ORDER BY ${orderBy}`)
      .all(fileId) as Array<{ id: number }>;
    return rows.map((row) => Number(row.id));
  }

  getChunkById(id: number): ChunkRow | null {
    const row = this.db
      .prepare(
        "SELECT id, file_id, chunk_index, content, vector FROM chunks WHERE id = ?",
      )
      .get(id) as ChunkQueryRow | undefined;
    return row ? toChunkRow(row) : null;
  }

  getAllChunks(): ChunkRow[] {
    const rows = this.db
      .prepare(
        "SELECT id, file_id, chunk_index, content, vector FROM chunks ORDER BY id",
      )
      .all() as ChunkQueryRow[];
    return rows.map(toChunkRow);
  }
}

function toChunkRow(row: ChunkQueryRow): ChunkRow {
  return {
    id: row.id,
    fileId: row.file_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    vector: row.vector || null,
  };
}
