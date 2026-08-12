import type { TdbChunkRow, TdbFileRow } from "../types/tdb.js";

export interface TdbFileQueryRow {
  id: number;
  library: string;
  path: string;
  checksum: string;
  mtime: number;
  size: number;
  doc_node_id?: number | null;
  updated_at?: number | null;
}

export interface TdbChunkQueryRow {
  id: number;
  library: string;
  path: string;
  chunk_index: number;
  node_id: number;
  text: string;
  checksum: string;
  vector?: Buffer | null;
}

export function mapTdbFileRow(row: TdbFileQueryRow): TdbFileRow {
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

export function mapTdbChunkRow(row: TdbChunkQueryRow): TdbChunkRow {
  return {
    id: row.id,
    library: row.library,
    path: row.path,
    chunkIndex: row.chunk_index,
    nodeId: row.node_id,
    text: row.text,
    checksum: row.checksum,
    vector: row.vector ?? null,
  };
}
