import { createHash } from "node:crypto";
import * as posixPath from "node:path/posix";

import type { RelationKind } from "./relation-types.js";

export function normalizeRelationPath(value: string): string {
  return posixPath.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
}

export interface RelationDocumentReference {
  documentId?: string | null;
  document_id?: string | null;
  path?: string | null;
  relPath?: string | null;
}

export function relationDocumentKey(input: RelationDocumentReference): string {
  return relationDocumentAliases(input)[0] || "path:";
}

/** Return every stable authority alias for a document. */
export function relationDocumentAliases(input: RelationDocumentReference): string[] {
  const aliases: string[] = [];
  const documentId = input.documentId ?? input.document_id;
  if (typeof documentId === "string" && documentId.trim()) {
    aliases.push(`document:${documentId.trim()}`);
  }
  const value = input.relPath || input.path || "";
  if (String(value).trim()) {
    aliases.push(`path:${normalizeRelationPath(String(value))}`);
  }
  if (aliases.length === 0) aliases.push("path:");
  return [...new Set(aliases)];
}

export function createRelationId(from: string, to: string, kind: RelationKind): string {
  return createHash("sha256")
    .update(`${from}\n${to}\n${kind}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

export function createRevisionedRelationId(
  from: string,
  to: string,
  kind: RelationKind,
  sourceRevision?: string,
): string {
  return createHash("sha256")
    .update(`${from}\n${to}\n${kind}\n${sourceRevision || ""}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}
