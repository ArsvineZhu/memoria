import type { ChunkEntry, TagEntry } from "../../types/documents.js";
import type {
  DocumentStateReplacementResult,
  DocumentTagReplacementResult,
  FileMetadataInput,
} from "../../types/metadata.js";
import type { MemoryRelationRecord } from "../../types/relations.js";
import type { PipelineData } from "../../types/pipeline.js";

export type MetadataWriterOutput = Omit<
  PipelineData,
  "fileId" | "chunkIds" | "tagIds" | "removedChunkIds"
> & {
  fileId: number | null;
  chunkIds: number[];
  tagIds: number[];
  removedChunkIds: number[];
  previousIndexName?: string | null;
  currentIndexName?: string;
  metadataOnly?: boolean;
};

export interface MetadataWriterSnapshot {
  input: PipelineData;
  relPath: string;
  space: string;
  checksum: string;
  mtime: number;
  size: number;
  sourceJson: string | null;
  metadataJson: string | null;
  documentId?: string;
  revision?: string;
  explicitRelations: MemoryRelationRecord[];
  relationSourceKey?: string;
  relationSourceRevision?: string;
}

export interface MetadataWriterReplacementOptions {
  preserveChunks?: boolean;
  preserveTags?: boolean;
  chunks?: readonly {
    chunkIndex: number;
    content: string;
    vector: Buffer | null;
  }[];
  tags?: readonly { name: string; vector: Buffer | null }[];
  orderedTagNames?: readonly string[];
}

export type MetadataWriterReplacement =
  DocumentStateReplacementResult | DocumentTagReplacementResult;

export interface MetadataWriterRows {
  chunks: MetadataWriterReplacementOptions["chunks"];
  tags: MetadataWriterReplacementOptions["tags"];
  orderedTagNames: readonly string[];
}

export interface MetadataWriterEntries {
  chunkEntries: ChunkEntry[];
  tagEntries: TagEntry[];
  tagNames: string[];
}

export function toFileMetadata(snapshot: MetadataWriterSnapshot): FileMetadataInput {
  return {
    path: snapshot.relPath,
    space: snapshot.space,
    checksum: snapshot.checksum,
    mtime: snapshot.mtime,
    size: snapshot.size,
    documentId: snapshot.documentId,
    revision: snapshot.revision,
    sourceJson: snapshot.sourceJson,
    metadataJson: snapshot.metadataJson,
  };
}
