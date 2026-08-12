import * as posixPath from "node:path/posix";

import type { MemoryRelation } from "./relation-types.js";
import {
  createRevisionedRelationId,
  normalizeRelationPath,
  relationDocumentKey,
} from "./relation-identifiers.js";

interface ParsedTarget {
  key: string;
  anchor: string | null;
}

function internalTarget(target: string, sourcePath: string): ParsedTarget | null {
  const trimmed = target.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    /^(?:https?:|mailto:|data:|javascript:|ftp:)/i.test(trimmed)
  ) {
    return null;
  }
  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    // Keep the literal target when a malformed escape is present.
  }
  const [withoutAnchor = "", rawAnchor = ""] = decoded.split("#", 2);
  decoded = (withoutAnchor.split("?")[0] ?? "").trim();
  const anchor = rawAnchor.trim() ? rawAnchor.trim() : null;
  if (!decoded) return null;

  const memoryUri = decoded.match(/^memory:\/\/(.+)$/i);
  if (memoryUri?.[1]) {
    return {
      key: `document:${decodeURIComponent(memoryUri[1])}`,
      anchor,
    };
  }
  const memoryId = decoded.match(/^memory:([^/].*)$/i);
  if (memoryId?.[1]) {
    return { key: `document:${decodeURIComponent(memoryId[1])}`, anchor };
  }

  const base = posixPath.dirname(normalizeRelationPath(sourcePath));
  const resolved = normalizeRelationPath(posixPath.join(base, decoded));
  return { key: `path:${resolved.replace(/^\/+/, "")}`, anchor };
}

function makeSourceRelation(
  from: string,
  to: string,
  evidence: string,
  now: number,
  sourceRevision?: string,
  sourceSpan?: { start: number; end: number } | null,
  targetAnchor?: string | null,
): MemoryRelation {
  return {
    id: createRevisionedRelationId(from, to, "explicit-link", sourceRevision),
    from,
    to,
    kind: "explicit-link",
    origin: "source",
    confidence: 1,
    weight: 1,
    evidence,
    sourceRevision: sourceRevision || null,
    sourceSpan: sourceSpan || null,
    targetAnchor: targetAnchor || null,
    createdAt: now,
    updatedAt: now,
    status: "active",
    active: true,
  };
}

/** Extract ordinary Markdown/Wiki/HTML links without evaluating MDX. */
export function extractMdxRelations(
  content: string,
  sourcePath: string,
  from: string = relationDocumentKey({ path: sourcePath }),
  sourceRevision?: string,
): MemoryRelation[] {
  const now = Date.now();
  const relations: MemoryRelation[] = [];
  const add = (target: string, evidence: string, start: number, end: number) => {
    const parsed = internalTarget(target, sourcePath);
    if (!parsed || parsed.key === from) return;
    relations.push(
      makeSourceRelation(
        from,
        parsed.key,
        evidence,
        now,
        sourceRevision,
        { start, end },
        parsed.anchor,
      ),
    );
  };

  // Mask fenced and inline code before scanning. This keeps code snippets and
  // code blocks from becoming durable user-source relations while retaining
  // ordinary Markdown/MDX links.
  const scanContent = content
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (block) => " ".repeat(block.length))
    .replace(/`[^`\n]*`/g, (code) => " ".repeat(code.length));

  for (const match of scanContent.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g)) {
    add(
      match[1] || "",
      "markdown-link",
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
    );
  }
  for (const match of scanContent.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    add(
      match[1] || "",
      "wikilink",
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
    );
  }
  for (const match of scanContent.matchAll(
    /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi,
  )) {
    add(
      match[1] || "",
      "html-link",
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
    );
  }

  // MemoryLink is an allow-listed, literal-only component. Expressions and
  // imported components are deliberately ignored; no MDX is evaluated.
  for (const match of scanContent.matchAll(/<MemoryLink\b([^>]*)\/?\s*>/gi)) {
    const attrs = match[1] || "";
    const target = attrs.match(/\b(?:target|to|href)\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!target) continue;
    const anchor = attrs.match(/\banchor\s*=\s*(["'])(.*?)\1/i)?.[2];
    const decorated = anchor && !target.includes("#") ? `${target}#${anchor}` : target;
    add(
      decorated,
      "memory-link",
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
    );
  }

  const unique = new Map<string, MemoryRelation>();
  for (const relation of relations) unique.set(relation.id, relation);
  return [...unique.values()];
}
