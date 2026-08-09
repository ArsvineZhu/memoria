import { createHash } from "node:crypto";

import { MemoriaError } from "../errors.js";

export const LOGICAL_DOCUMENT_PREFIX = "__logical__";

export function normalizeDocumentId(documentId: unknown): string {
  if (typeof documentId !== "string" || documentId.trim().length === 0) {
    throw new MemoriaError("ingestion", "A logical document id is required.");
  }
  return documentId;
}

/** Stable internal key that cannot be confused with a user filesystem path. */
export function logicalDocumentPath(documentId: string): string {
  const digest = createHash("sha256").update(documentId, "utf8").digest("hex");
  return `${LOGICAL_DOCUMENT_PREFIX}/${digest}`;
}

export function serializeDocumentJson(
  value: unknown,
  fieldName: string,
): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value) ?? null;
  } catch (error) {
    throw new MemoriaError(
      "ingestion",
      `Logical document ${fieldName} must be JSON-serializable.`,
      { cause: error },
    );
  }
}
