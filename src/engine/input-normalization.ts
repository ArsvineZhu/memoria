import type { UnknownRecord } from "../types/common.js";
import type { FileInput, MemoryDocumentSource } from "../types/documents.js";
export { normalizeMutationPath } from "../utils/mutation-path.js";

export function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalize flush() inputs at the public boundary. The engine receives
 * watcher-shaped values, while ingestion stages consume one stable FileInput.
 */
export function normalizeFiles(files: unknown): FileInput[] {
  if (files == null) return [];
  const list: unknown[] = Array.isArray(files) ? files : [files];
  return list.map((entry: unknown): FileInput => {
    if (typeof entry === "string") return { path: entry };
    if (!isRecord(entry)) return { path: "" };
    return {
      path: typeof entry.path === "string" ? entry.path : "",
      relPath: typeof entry.relPath === "string" ? entry.relPath : undefined,
      content: typeof entry.content === "string" ? entry.content : undefined,
      sourceContent:
        typeof entry.sourceContent === "string" ? entry.sourceContent : undefined,
      mtime: typeof entry.mtime === "number" ? entry.mtime : undefined,
      size: typeof entry.size === "number" ? entry.size : undefined,
      documentId: typeof entry.documentId === "string" ? entry.documentId : undefined,
      revision: typeof entry.revision === "string" ? entry.revision : undefined,
      documentSource: isRecord(entry.documentSource)
        ? (entry.documentSource as MemoryDocumentSource)
        : undefined,
      documentMetadata: isRecord(entry.documentMetadata)
        ? entry.documentMetadata
        : undefined,
      space: typeof entry.space === "string" ? entry.space : undefined,
    };
  });
}
