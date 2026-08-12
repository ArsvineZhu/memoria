import type BetterSqlite3 from "better-sqlite3";

import { relationDocumentAliases } from "../../retrieval/relation-graph.js";
import type {
  IndexableChunkRow,
  RetrievalScopeFilters,
  RetrievalScopeResolution,
} from "../../types/metadata.js";
import type { SearchCorpusChunk } from "../../types/vector.js";
import type { UnknownRecord } from "../../types/common.js";

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

/** Read-only retrieval projections over the SQLite authority. */
export default class SqliteRetrievalRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  getSearchCorpus(indexNames?: readonly string[]): SearchCorpusChunk[] {
    if (Array.isArray(indexNames) && indexNames.length === 0) return [];
    let sql = `SELECT c.id, c.content, f.space AS index_name FROM chunks c JOIN files f ON f.id = c.file_id`;
    const params: string[] = [];
    if (Array.isArray(indexNames) && indexNames.length > 0) {
      sql += ` WHERE f.space IN (${indexNames.map(() => "?").join(", ")})`;
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

  resolveScope(
    filters: RetrievalScopeFilters,
    indexNames?: readonly string[],
  ): RetrievalScopeResolution {
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
      where.push(`f.space IN (${spaces.map(() => "?").join(", ")})`);
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
         FROM chunks c JOIN files f ON f.id = c.file_id
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
      if (filters.metadata && !matchesMetadataJson(row.metadata_json, filters.metadata))
        continue;
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

  getIndexableChunks(): IndexableChunkRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.id AS chunk_id, c.vector, f.space AS index_name
         FROM chunks c JOIN files f ON c.file_id = f.id ORDER BY c.id`,
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
}
