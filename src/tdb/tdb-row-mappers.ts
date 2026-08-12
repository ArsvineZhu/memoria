import type { TdbChunkRow, TdbFileRow } from "../types/tdb.js";

export interface TdbFileQueryRow {
  id: number;
  library: string;
  path: string;
  checksum: string;
  source_updated_at: number;
  size: number;
  doc_node_id?: number | null;
  recorded_at: number;
  indexed_at: number;
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
    source_updated_at: row.source_updated_at,
    size: row.size,
    doc_node_id: row.doc_node_id ?? null,
    recorded_at: row.recorded_at,
    indexed_at: row.indexed_at,
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
