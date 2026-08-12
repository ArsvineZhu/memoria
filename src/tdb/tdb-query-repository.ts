import type BetterSqlite3 from "better-sqlite3";

import type {
  TdbChunkRow,
  TdbCorpusChunk,
  TdbRebuildChunk,
  TdbFileRow,
} from "../types/tdb.js";
import type { SearchCorpusChunk } from "../types/vector.js";
import {
  mapTdbChunkRow,
  mapTdbFileRow,
  type TdbChunkQueryRow,
  type TdbFileQueryRow,
} from "./tdb-row-mappers.js";

/** Read models used by TDB retrieval and lifecycle diagnostics. */
export class TdbQueryRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  async getFile(library: string, path: string): Promise<TdbFileRow | null> {
    const row = this.db
      .prepare("SELECT * FROM files WHERE library = ? AND path = ?")
      .get(library, path) as TdbFileQueryRow | undefined;
    return row ? mapTdbFileRow(row) : null;
  }

  async getFileById(id: number): Promise<TdbFileRow | null> {
    const row = this.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as
      TdbFileQueryRow | undefined;
    return row ? mapTdbFileRow(row) : null;
  }

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
    return row ? mapTdbFileRow(row) : null;
  }

  async getChunks(library: string, path: string): Promise<TdbChunkRow[]> {
    const rows = this.db
      .prepare(
        "SELECT id, library, path, chunk_index, node_id, text, checksum, vector FROM chunks WHERE library = ? AND path = ? ORDER BY chunk_index",
      )
      .all(library, path) as TdbChunkQueryRow[];
    return rows.map(mapTdbChunkRow);
  }

  async getChunkById(id: number): Promise<TdbChunkRow | null> {
    const row = this.db
      .prepare(
        "SELECT id, library, path, chunk_index, node_id, text, checksum, vector FROM chunks WHERE id = ?",
      )
      .get(Number(id)) as TdbChunkQueryRow | undefined;
    return row ? mapTdbChunkRow(row) : null;
  }

  async getAllChunks(): Promise<TdbCorpusChunk[]> {
    const rows = this.db
      .prepare("SELECT id, library, text FROM chunks ORDER BY id")
      .all() as Array<{ id: number; library: string; text: string }>;
    return rows.map((row) => ({
      id: row.id,
      content: row.text,
      indexName: row.library,
    }));
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

  async listLibraries(): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT DISTINCT library FROM files ORDER BY library")
      .all() as Array<{ library: string }>;
    return rows.map((row) => row.library);
  }

  async getDistinctSpaces(): Promise<string[]> {
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

  async countFiles(): Promise<number> {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM files").get() as {
      c?: number;
    };
    return Number(row?.c) || 0;
  }
}
