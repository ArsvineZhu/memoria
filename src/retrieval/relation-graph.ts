"use strict";

import { createHash } from "node:crypto";
import * as posixPath from "node:path/posix";

import type { FileRow, MemoryRelationRecord, MetadataStoreContract } from "../types.js";

export type RelationKind = "explicit-link" | "derived-link" | "tag" | "sequence";
export type RelationOrigin = "source" | "derived";
export type RelationStatus = "active" | "stale" | "rejected";

export type MemoryRelation = MemoryRelationRecord;

export interface RelationGraphSnapshot {
  schema: "memoria-relation-graph-v1";
  revision: number;
  relations: MemoryRelation[];
}

export interface RelatedChunk {
  chunkId: number;
  documentKey: string;
  distance: number;
  relationIds: string[];
  confidence: number;
}

const RELATION_GRAPH_KEY = "memoria.relation_graph.v1";

interface RelationReadCache {
  adjacencyGeneration: number | null;
  adjacency: Map<string, MemoryRelation[]>;
  fullGraphGeneration: number | null;
  fullGraph: MemoryRelation[] | null;
}

const relationReadCaches = new WeakMap<object, RelationReadCache>();

function normalizePath(value: string): string {
  return posixPath.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
}

export function relationDocumentKey(input: {
  documentId?: string | null;
  document_id?: string | null;
  path?: string | null;
  relPath?: string | null;
}): string {
  const documentId = input.documentId ?? input.document_id;
  if (typeof documentId === "string" && documentId.trim()) {
    return `document:${documentId.trim()}`;
  }
  const value = input.relPath || input.path || "";
  return `path:${normalizePath(String(value))}`;
}

function relationId(from: string, to: string, kind: RelationKind): string {
  return createHash("sha256")
    .update(`${from}\n${to}\n${kind}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function revisionedRelationId(
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

  const base = posixPath.dirname(normalizePath(sourcePath));
  const resolved = normalizePath(posixPath.join(base, decoded));
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
    id: revisionedRelationId(from, to, "explicit-link", sourceRevision),
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

  // Mask fenced and inline code before scanning. This keeps examples and
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

function asSnapshot(value: unknown): RelationGraphSnapshot {
  if (!value || typeof value !== "object") {
    return { schema: "memoria-relation-graph-v1", revision: 0, relations: [] };
  }
  const source = value as Record<string, unknown>;
  const relations = Array.isArray(source.relations)
    ? source.relations.filter((item): item is MemoryRelation => {
        if (!item || typeof item !== "object") return false;
        const row = item as Record<string, unknown>;
        return (
          typeof row.id === "string" &&
          typeof row.from === "string" &&
          typeof row.to === "string" &&
          (row.status === undefined || typeof row.status === "string")
        );
      })
    : [];
  return {
    schema: "memoria-relation-graph-v1",
    revision: Number.isSafeInteger(source.revision) ? Number(source.revision) : 0,
    relations: relations.map((relation) => ({
      ...relation,
      status:
        relation.status === "stale" || relation.status === "rejected"
          ? relation.status
          : "active",
      active:
        (relation.active ?? true) &&
        relation.status !== "stale" &&
        relation.status !== "rejected",
    })),
  };
}

/** Durable relation graph backed by the host metadata store's KV channel. */
export class RelationGraphStore {
  private readonly metadataStore: MetadataStoreContract;
  private fallback: RelationGraphSnapshot = {
    schema: "memoria-relation-graph-v1",
    revision: 0,
    relations: [],
  };
  private tail: Promise<void> = Promise.resolve();
  private legacyMigrationAttempted = false;
  private readonly readCache: RelationReadCache;

  constructor(metadataStore: MetadataStoreContract) {
    this.metadataStore = metadataStore;
    const existing = relationReadCaches.get(metadataStore as object);
    if (existing) {
      this.readCache = existing;
    } else {
      this.readCache = {
        adjacencyGeneration: null,
        adjacency: new Map(),
        fullGraphGeneration: null,
        fullGraph: null,
      };
      relationReadCaches.set(metadataStore as object, this.readCache);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async load(): Promise<RelationGraphSnapshot> {
    if (typeof this.metadataStore.listRelations === "function") {
      let relations = await this.metadataStore.listRelations({
        includeInactive: true,
      });
      if (
        relations.length === 0 &&
        !this.legacyMigrationAttempted &&
        typeof this.metadataStore.getKv === "function"
      ) {
        this.legacyMigrationAttempted = true;
        const legacyRaw = await this.metadataStore.getKv(RELATION_GRAPH_KEY);
        let legacyValue: unknown = legacyRaw;
        if (typeof legacyRaw === "string") {
          try {
            legacyValue = JSON.parse(legacyRaw);
          } catch {
            legacyValue = null;
          }
        }
        const legacy = asSnapshot(legacyValue);
        if (legacy.relations.length > 0) {
          const sources = new Map<string, MemoryRelation[]>();
          const derived: MemoryRelation[] = [];
          for (const relation of legacy.relations) {
            if (relation.origin === "source") {
              const group = sources.get(relation.from) || [];
              group.push(relation);
              sources.set(relation.from, group);
            } else {
              derived.push(relation);
            }
          }
          if (typeof this.metadataStore.replaceExplicitRelations === "function") {
            for (const [from, group] of sources) {
              await this.metadataStore.replaceExplicitRelations(
                from,
                group[0]?.sourceRevision || `legacy-kv:${legacy.revision}`,
                group,
              );
            }
          }
          if (
            derived.length > 0 &&
            typeof this.metadataStore.upsertDerivedRelations === "function"
          ) {
            await this.metadataStore.upsertDerivedRelations(derived);
          }
          relations = await this.metadataStore.listRelations({ includeInactive: true });
        }
      }
      const generation =
        typeof this.metadataStore.getRelationGeneration === "function"
          ? await this.metadataStore.getRelationGeneration()
          : relations.length;
      this.fallback = {
        schema: "memoria-relation-graph-v1",
        revision: generation,
        relations: relations.map((relation) => ({ ...relation })),
      };
      return this.fallback;
    }
    if (typeof this.metadataStore.getKv !== "function") return this.fallback;
    const raw = await this.metadataStore.getKv(RELATION_GRAPH_KEY);
    if (!raw) return this.fallback;
    let parsed: unknown = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return this.fallback;
      }
    }
    this.fallback = asSnapshot(parsed);
    return this.fallback;
  }

  private async save(snapshot: RelationGraphSnapshot): Promise<void> {
    this.fallback = snapshot;
    if (typeof this.metadataStore.setKv === "function") {
      await this.metadataStore.setKv(RELATION_GRAPH_KEY, JSON.stringify(snapshot));
    }
  }

  async replaceSourceRelations(
    from: string,
    relations: readonly MemoryRelation[],
  ): Promise<RelationGraphSnapshot> {
    return this.enqueue(async () => {
      const sourceRevision =
        relations.find((relation) => relation.sourceRevision)?.sourceRevision ||
        `legacy:${Date.now()}`;
      if (typeof this.metadataStore.replaceExplicitRelations === "function") {
        await this.metadataStore.replaceExplicitRelations(
          from,
          sourceRevision,
          relations,
        );
        return this.load();
      }
      const current = await this.load();
      const retained = current.relations.filter(
        (relation) =>
          !(relation.from === from && relation.origin === "source" && relation.active),
      );
      const next: RelationGraphSnapshot = {
        schema: "memoria-relation-graph-v1",
        revision: current.revision + 1,
        relations: [...retained, ...relations],
      };
      await this.save(next);
      return next;
    });
  }

  async addDerivedRelations(
    relations: readonly (Omit<
      MemoryRelation,
      "id" | "origin" | "createdAt" | "updatedAt" | "status"
    > &
      Partial<
        Pick<MemoryRelation, "id" | "origin" | "createdAt" | "updatedAt" | "status">
      >)[],
  ): Promise<RelationGraphSnapshot> {
    return this.enqueue(async () => {
      if (typeof this.metadataStore.upsertDerivedRelations === "function") {
        await this.metadataStore.upsertDerivedRelations(relations);
        return this.load();
      }
      const current = await this.load();
      const now = Date.now();
      const byId = new Map(
        current.relations.map((relation) => [relation.id, relation]),
      );
      for (const candidate of relations) {
        const id =
          candidate.id || relationId(candidate.from, candidate.to, candidate.kind);
        const previous = byId.get(id);
        const next: MemoryRelation = {
          ...candidate,
          id,
          origin: "derived",
          confidence: Math.max(0, Math.min(1, Number(candidate.confidence) || 0)),
          weight: Math.max(0, Number(candidate.weight) || 0),
          createdAt: previous?.createdAt ?? candidate.createdAt ?? now,
          updatedAt: now,
          status: !(candidate.active ?? true)
            ? candidate.status === "rejected"
              ? "rejected"
              : "stale"
            : "active",
          active: (candidate.active ?? true) && candidate.status !== "rejected",
        };
        if (!previous || next.confidence >= previous.confidence || !next.active) {
          byId.set(id, next);
        }
      }
      const nextSnapshot: RelationGraphSnapshot = {
        schema: "memoria-relation-graph-v1",
        revision: current.revision + 1,
        relations: [...byId.values()].filter((relation) => relation.active),
      };
      await this.save(nextSnapshot);
      return nextSnapshot;
    });
  }

  async markSourceRelationsStale(from: string): Promise<RelationGraphSnapshot> {
    return this.enqueue(async () => {
      if (typeof this.metadataStore.markExplicitRelationsStale === "function") {
        await this.metadataStore.markExplicitRelationsStale(from);
        return this.load();
      }
      const current = await this.load();
      const changed = current.relations.map((relation) => {
        if (
          relation.from !== from ||
          relation.origin !== "source" ||
          !relation.active
        ) {
          return relation;
        }
        return {
          ...relation,
          active: false,
          status: "stale" as const,
          updatedAt: Date.now(),
        };
      });
      const next: RelationGraphSnapshot = {
        schema: "memoria-relation-graph-v1",
        revision: current.revision + 1,
        relations: changed,
      };
      await this.save(next);
      return next;
    });
  }

  async relatedDocumentKeys(
    starts: readonly string[],
    maxHops = 1,
    allowedDocumentKeys?: ReadonlySet<string>,
  ): Promise<
    Map<string, { distance: number; relationIds: string[]; confidence: number }>
  > {
    const limit = Math.max(0, Math.min(8, Math.trunc(maxHops)));
    const found = new Map<
      string,
      { distance: number; relationIds: string[]; confidence: number }
    >();
    let frontier = [...new Set(starts)]
      .filter((key) => !allowedDocumentKeys || allowedDocumentKeys.has(key))
      .map((key) => ({
        key,
        distance: 0,
        relationIds: [] as string[],
        confidence: 1,
      }));
    const bestDistance = new Map(frontier.map((item) => [item.key, 0]));
    for (let distance = 1; distance <= limit && frontier.length > 0; distance += 1) {
      const adjacent = new Map<string, Array<MemoryRelation>>();
      const sourceKeys = frontier.map((item) => item.key);
      const sourceKeySet = new Set(sourceKeys);
      let relations: MemoryRelation[];
      if (typeof this.metadataStore.getAdjacentRelations === "function") {
        const generation =
          typeof this.metadataStore.getRelationGeneration === "function"
            ? await this.metadataStore.getRelationGeneration()
            : null;
        const cacheable = generation !== null;
        if (cacheable && generation !== this.readCache.adjacencyGeneration) {
          this.readCache.adjacencyGeneration = generation;
          this.readCache.adjacency.clear();
        }
        const cacheKey = [...new Set(sourceKeys)].sort().join("\u0000");
        const cached = cacheable ? this.readCache.adjacency.get(cacheKey) : undefined;
        if (cached) {
          relations = cached;
        } else {
          relations = await this.metadataStore.getAdjacentRelations(sourceKeys);
          if (cacheable) {
            this.readCache.adjacency.set(
              cacheKey,
              relations.map((relation) => ({ ...relation })),
            );
          }
        }
      } else {
        const generation =
          typeof this.metadataStore.getRelationGeneration === "function"
            ? await this.metadataStore.getRelationGeneration()
            : null;
        if (
          !this.readCache.fullGraph ||
          typeof this.metadataStore.getRelationGeneration !== "function" ||
          generation !== this.readCache.fullGraphGeneration
        ) {
          this.readCache.fullGraph = (await this.load()).relations.map((relation) => ({
            ...relation,
          }));
          this.readCache.fullGraphGeneration = generation;
        }
        relations = this.readCache.fullGraph;
      }
      for (const relation of relations) {
        if (!relation.active || relation.status !== "active") continue;
        if (sourceKeySet.has(relation.from)) {
          if (!allowedDocumentKeys || allowedDocumentKeys.has(relation.to)) {
            const forward = adjacent.get(relation.from) || [];
            forward.push(relation);
            adjacent.set(relation.from, forward);
          }
        }
        if (sourceKeySet.has(relation.to)) {
          if (!allowedDocumentKeys || allowedDocumentKeys.has(relation.from)) {
            const backward = adjacent.get(relation.to) || [];
            backward.push({ ...relation, from: relation.to, to: relation.from });
            adjacent.set(relation.to, backward);
          }
        }
      }
      for (const edges of adjacent.values()) {
        edges.sort(
          (left, right) =>
            Number(right.origin === "source") - Number(left.origin === "source") ||
            Number(right.confidence) - Number(left.confidence) ||
            Number(right.weight) - Number(left.weight) ||
            left.id.localeCompare(right.id),
        );
      }
      const next: typeof frontier = [];
      for (const source of frontier) {
        for (const relation of adjacent.get(source.key) || []) {
          const previousDistance = bestDistance.get(relation.to);
          if (previousDistance !== undefined && previousDistance <= distance) continue;
          bestDistance.set(relation.to, distance);
          next.push({
            key: relation.to,
            distance,
            relationIds: [...source.relationIds, relation.id],
            confidence: Math.max(
              0,
              Math.min(
                1,
                source.confidence *
                  Math.max(0, Math.min(1, Number(relation.confidence) || 0)),
              ),
            ),
          });
          const existing = found.get(relation.to);
          if (!existing || distance < existing.distance) {
            found.set(relation.to, {
              distance,
              relationIds: [...source.relationIds, relation.id],
              confidence: Math.max(
                0,
                Math.min(
                  1,
                  source.confidence *
                    Math.max(0, Math.min(1, Number(relation.confidence) || 0)),
                ),
              ),
            });
          }
        }
      }
      frontier = next;
    }
    return found;
  }

  async relatedChunks(
    seedChunkIds: readonly number[],
    maxHops = 1,
    maxAdded = 100,
    allowedDocumentKeys?: ReadonlySet<string>,
  ): Promise<RelatedChunk[]> {
    const store = this.metadataStore;
    if (typeof store.getFileByChunkId !== "function") return [];
    const starts: string[] = [];
    for (const chunkId of seedChunkIds) {
      const file = await store.getFileByChunkId(Number(chunkId));
      if (file) starts.push(relationDocumentKey(file));
    }
    const related = await this.relatedDocumentKeys(
      starts,
      maxHops,
      allowedDocumentKeys,
    );
    const results: RelatedChunk[] = [];
    for (const [documentKey, detail] of related) {
      const file = await this.resolveFile(documentKey);
      if (!file || typeof store.getChunksByFileId !== "function") continue;
      const chunks = await store.getChunksByFileId(file.id);
      for (const chunk of chunks || []) {
        const chunkId = Number(chunk.id);
        if (!Number.isFinite(chunkId)) continue;
        results.push({ chunkId, documentKey, ...detail });
        if (results.length >= Math.max(0, Math.round(maxAdded))) return results;
      }
    }
    return results;
  }

  private async resolveFile(documentKey: string): Promise<FileRow | null> {
    const store = this.metadataStore;
    if (
      documentKey.startsWith("document:") &&
      typeof store.getFileByDocumentId === "function"
    ) {
      return store.getFileByDocumentId(documentKey.slice("document:".length));
    }
    if (documentKey.startsWith("path:") && typeof store.getFileByPath === "function") {
      const path = documentKey.slice("path:".length);
      const direct = await store.getFileByPath(path);
      if (direct) return direct;
      for (const suffix of [".mdx", ".md"]) {
        const candidate = await store.getFileByPath(`${path}${suffix}`);
        if (candidate) return candidate;
      }
    }
    return null;
  }
}

export { RELATION_GRAPH_KEY };
