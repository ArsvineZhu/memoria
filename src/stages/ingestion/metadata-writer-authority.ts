import type {
  DocumentStateReplacementResult,
  MetadataStoreContract,
} from "../../types/metadata.js";
import type { ChunkEntry, TagEntry } from "../../types/documents.js";
import { MemoriaError } from "../../errors.js";
import { encodeVectorBlob } from "../../utils/vector-codec.js";
import {
  type MetadataWriterEntries,
  type MetadataWriterReplacement,
  type MetadataWriterReplacementOptions,
  type MetadataWriterRows,
  type MetadataWriterSnapshot,
  toFileMetadata,
} from "./metadata-writer-types.js";

export interface MetadataWriterAuthority {
  metadataStore: MetadataStoreContract;
  snapshot: MetadataWriterSnapshot;
  hasRelationAuthority: boolean;
}

export function createAuthority(
  metadataStore: MetadataStoreContract,
  snapshot: MetadataWriterSnapshot,
  hasRelationAuthority: boolean,
): MetadataWriterAuthority {
  return { metadataStore, snapshot, hasRelationAuthority };
}

export function serializeEntries(input: MetadataWriterEntries): MetadataWriterRows {
  return {
    chunks: input.chunkEntries.map((entry) => ({
      chunkIndex: entry.chunkIndex,
      content: entry.content,
      vector: entry.vector == null ? null : encodeVectorBlob(entry.vector),
    })),
    tags: input.tagEntries.map((entry) => ({
      name: entry.name,
      vector: entry.vector == null ? null : encodeVectorBlob(entry.vector),
    })),
    orderedTagNames: input.tagNames,
  };
}

export async function replaceDocumentAuthority(
  authority: MetadataWriterAuthority,
  options: MetadataWriterReplacementOptions = {},
): Promise<DocumentStateReplacementResult> {
  if (
    !authority.hasRelationAuthority ||
    typeof authority.metadataStore.replaceDocumentAuthority !== "function"
  ) {
    throw new MemoriaError(
      "configuration",
      "Relation-enabled ingestion requires metadataStore.replaceDocumentAuthority for an atomic document and relation commit.",
    );
  }

  return authority.metadataStore.replaceDocumentAuthority({
    file: toFileMetadata(authority.snapshot),
    chunks: options.chunks || [],
    tags: options.tags || [],
    orderedTagNames: options.orderedTagNames || [],
    explicitRelations: authority.snapshot.explicitRelations,
    relationSourceKey: authority.snapshot.relationSourceKey!,
    relationSourceRevision: authority.snapshot.relationSourceRevision!,
    preserveChunks: options.preserveChunks,
    preserveTags: options.preserveTags,
  });
}

export async function replaceDocumentTags(
  authority: MetadataWriterAuthority,
  tagEntries: readonly TagEntry[],
  tagNames: readonly string[],
): Promise<MetadataWriterReplacement> {
  const tags = tagEntries.map((entry) => ({
    name: entry.name,
    vector: entry.vector == null ? null : encodeVectorBlob(entry.vector),
  }));

  if (authority.hasRelationAuthority) {
    if (typeof authority.metadataStore.replaceDocumentAuthority !== "function") {
      throw new MemoriaError(
        "configuration",
        "Relation-enabled tag updates require metadataStore.replaceDocumentAuthority.",
      );
    }
    return replaceDocumentAuthority(authority, {
      preserveChunks: true,
      tags,
      orderedTagNames: tagNames,
    });
  }

  if (typeof authority.metadataStore.replaceDocumentTags !== "function") {
    throw new MemoriaError(
      "configuration",
      "Tag-only ingestion requires metadataStore.replaceDocumentTags for atomic metadata and tag updates.",
    );
  }
  return authority.metadataStore.replaceDocumentTags({
    file: toFileMetadata(authority.snapshot),
    tags,
    orderedTagNames: tagNames,
  });
}

export function readEntries(input: {
  chunkEntries?: ChunkEntry[];
  tagEntries?: TagEntry[];
  tags?: string[];
}): MetadataWriterEntries {
  return {
    chunkEntries: Array.isArray(input.chunkEntries) ? input.chunkEntries : [],
    tagEntries: Array.isArray(input.tagEntries) ? input.tagEntries : [],
    tagNames: Array.isArray(input.tags) ? input.tags : [],
  };
}
