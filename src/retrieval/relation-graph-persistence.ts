import type { MetadataStoreContract } from "../types/metadata.js";
import type { MemoryRelation, RelationGraphSnapshot } from "./relation-types.js";
import { createRelationId } from "./relation-identifiers.js";

export const RELATION_GRAPH_KEY = "relation_graph";

interface RelationReadCache {
  adjacencyGeneration: number | null;
  adjacency: Map<string, MemoryRelation[]>;
  fullGraphGeneration: number | null;
  fullGraph: MemoryRelation[] | null;
}

const relationReadCaches = new WeakMap<object, RelationReadCache>();

function emptySnapshot(): RelationGraphSnapshot {
  return { schema: "relation-graph-v1", revision: 0, relations: [] };
}

function asSnapshot(value: unknown): RelationGraphSnapshot {
  if (!value || typeof value !== "object") return emptySnapshot();
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
    schema: "relation-graph-v1",
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

/** Owns relation authority persistence and generation-aware read caching. */
export default class RelationGraphPersistence {
  private fallback: RelationGraphSnapshot = emptySnapshot();
  private readonly readCache: RelationReadCache;

  constructor(private readonly metadataStore: MetadataStoreContract) {
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

  async load(): Promise<RelationGraphSnapshot> {
    if (typeof this.metadataStore.listRelations === "function") {
      const relations = await this.metadataStore.listRelations({
        includeInactive: true,
      });
      const generation =
        typeof this.metadataStore.getRelationGeneration === "function"
          ? await this.metadataStore.getRelationGeneration()
          : relations.length;
      this.fallback = {
        schema: "relation-graph-v1",
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

  async replaceSourceRelations(
    from: string,
    relations: readonly MemoryRelation[],
  ): Promise<RelationGraphSnapshot> {
    const sourceRevision =
      relations.find((relation) => relation.sourceRevision)?.sourceRevision ||
      `relation:${Date.now()}`;
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
      schema: "relation-graph-v1",
      revision: current.revision + 1,
      relations: [...retained, ...relations],
    };
    await this.save(next);
    return next;
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
    if (typeof this.metadataStore.upsertDerivedRelations === "function") {
      await this.metadataStore.upsertDerivedRelations(relations);
      return this.load();
    }
    const current = await this.load();
    const now = Date.now();
    const byId = new Map(current.relations.map((relation) => [relation.id, relation]));
    for (const candidate of relations) {
      const id =
        candidate.id || createRelationId(candidate.from, candidate.to, candidate.kind);
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
      schema: "relation-graph-v1",
      revision: current.revision + 1,
      relations: [...byId.values()].filter((relation) => relation.active),
    };
    await this.save(nextSnapshot);
    return nextSnapshot;
  }

  async markSourceRelationsStale(from: string): Promise<RelationGraphSnapshot> {
    if (typeof this.metadataStore.markExplicitRelationsStale === "function") {
      await this.metadataStore.markExplicitRelationsStale(from);
      return this.load();
    }
    const current = await this.load();
    const changed = current.relations.map((relation) => {
      if (relation.from !== from || relation.origin !== "source" || !relation.active) {
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
      schema: "relation-graph-v1",
      revision: current.revision + 1,
      relations: changed,
    };
    await this.save(next);
    return next;
  }

  async relationsForKeys(keys: readonly string[]): Promise<MemoryRelation[]> {
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
      const cacheKey = [...new Set(keys)].sort().join("\u0000");
      const cached = cacheable ? this.readCache.adjacency.get(cacheKey) : undefined;
      if (cached) return cached;
      const relations = await this.metadataStore.getAdjacentRelations(keys);
      if (cacheable) {
        this.readCache.adjacency.set(
          cacheKey,
          relations.map((relation) => ({ ...relation })),
        );
      }
      return relations;
    }

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
    return this.readCache.fullGraph;
  }

  private async save(snapshot: RelationGraphSnapshot): Promise<void> {
    this.fallback = snapshot;
    if (typeof this.metadataStore.setKv === "function") {
      await this.metadataStore.setKv(RELATION_GRAPH_KEY, JSON.stringify(snapshot));
    }
  }
}
