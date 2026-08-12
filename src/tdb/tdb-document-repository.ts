import type BetterSqlite3 from "better-sqlite3";

import type {
  TdbChunkInput,
  TdbDeleteDocumentStateResult,
  TdbDocumentStateReplacement,
  TdbDocumentStateReplacementResult,
  TdbInsertedChunk,
} from "../types/tdb.js";
import { TDB_VECTOR_DIRTY_KEY, TdbGenerationStore } from "./tdb-schema.js";

/** Transactional authority writes for the TDB metadata database. */
export class TdbDocumentRepository {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly generations: TdbGenerationStore,
  ) {}

  async upsertFile(meta: {
    library: string;
    path: string;
    checksum: string;
    sourceUpdatedAt: number;
    size: number;
    docNodeId?: number | null;
    recordedAt?: number;
    indexedAt?: number;
  }): Promise<number | null> {
    const indexedAt = Number.isFinite(Number(meta.indexedAt))
      ? Math.floor(Number(meta.indexedAt))
      : Date.now();
    const recordedAt = Number.isFinite(Number(meta.recordedAt))
      ? Math.floor(Number(meta.recordedAt))
      : indexedAt;
    const transaction = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          "SELECT id, checksum, source_updated_at, size, doc_node_id, recorded_at, indexed_at FROM files WHERE library = ? AND path = ?",
        )
        .get(meta.library, meta.path) as
        | {
            id: number;
            checksum: string;
            source_updated_at: number;
            size: number;
            doc_node_id?: number | null;
            recorded_at: number;
            indexed_at: number;
          }
        | undefined;
      const changed =
        !existing ||
        existing.checksum !== meta.checksum ||
        Number(existing.source_updated_at) !== Number(meta.sourceUpdatedAt) ||
        Number(existing.size) !== Number(meta.size) ||
        (existing.doc_node_id ?? null) !== (meta.docNodeId ?? null) ||
        Number(existing.recorded_at) !== recordedAt;

      this.db
        .prepare(
          `
          INSERT INTO files (library, path, checksum, source_updated_at, size, doc_node_id, recorded_at, indexed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(library, path) DO UPDATE SET
              checksum = excluded.checksum,
              source_updated_at = excluded.source_updated_at,
              size = excluded.size,
              doc_node_id = excluded.doc_node_id,
              recorded_at = excluded.recorded_at,
              indexed_at = excluded.indexed_at
        `,
        )
        .run(
          meta.library,
          meta.path,
          meta.checksum,
          meta.sourceUpdatedAt,
          meta.size,
          meta.docNodeId ?? null,
          recordedAt,
          indexedAt,
        );
      const row = this.db
        .prepare("SELECT id FROM files WHERE library = ? AND path = ?")
        .get(meta.library, meta.path) as { id?: number } | undefined;
      if (changed) {
        this.generations.incrementMetadataGeneration();
        this.generations.setInTransaction(TDB_VECTOR_DIRTY_KEY, "1");
      }
      return row?.id ?? null;
    });
    return transaction();
  }

  async replaceDocumentState(
    replacement: TdbDocumentStateReplacement,
  ): Promise<TdbDocumentStateReplacementResult> {
    const { file, chunks } = replacement;
    const recordedAt = Number.isFinite(Number(file.recordedAt))
      ? Number(file.recordedAt)
      : Number(file.sourceUpdatedAt);
    const indexedAt = Number.isFinite(Number(file.indexedAt))
      ? Number(file.indexedAt)
      : Date.now();
    const transaction = this.db.transaction(() => {
      const oldRows = this.db
        .prepare(
          "SELECT id, node_id FROM chunks WHERE library = ? AND path = ? ORDER BY chunk_index",
        )
        .all(file.library, file.path) as Array<{ id: number; node_id: number }>;

      this.db
        .prepare(
          `
          INSERT INTO files (library, path, checksum, source_updated_at, size, recorded_at, indexed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(library, path) DO UPDATE SET
            checksum = excluded.checksum,
            source_updated_at = excluded.source_updated_at,
            size = excluded.size,
            recorded_at = excluded.recorded_at,
            indexed_at = excluded.indexed_at
        `,
        )
        .run(
          file.library,
          file.path,
          file.checksum,
          file.sourceUpdatedAt,
          file.size,
          recordedAt,
          indexedAt,
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

      const metadataGeneration = this.generations.incrementMetadataGeneration();
      this.generations.setInTransaction(TDB_VECTOR_DIRTY_KEY, "1");
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
          metadataGeneration: this.generations.readMetadataGeneration(),
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
      const metadataGeneration = this.generations.incrementMetadataGeneration();
      this.generations.setInTransaction(TDB_VECTOR_DIRTY_KEY, "1");
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
      this.generations.incrementMetadataGeneration();
      this.generations.setInTransaction(TDB_VECTOR_DIRTY_KEY, "1");
      return result;
    });
    return transaction();
  }

  async updateChunkVectors(
    entries: readonly { chunkId: number; vector: Buffer | null }[],
  ): Promise<void> {
    const update = this.db.prepare("UPDATE chunks SET vector = ? WHERE id = ?");
    this.db.transaction(() => {
      for (const entry of entries) update.run(entry.vector, entry.chunkId);
      if (entries.length > 0) {
        this.generations.incrementMetadataGeneration();
        this.generations.setInTransaction(TDB_VECTOR_DIRTY_KEY, "1");
      }
    })();
  }
}
