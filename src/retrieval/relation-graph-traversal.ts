import type { FileRow, MetadataStoreContract } from "../types/metadata.js";
import type { MemoryRelation, RelatedChunk } from "./relation-types.js";
import { relationDocumentAliases } from "./relation-identifiers.js";
import RelationGraphPersistence from "./relation-graph-persistence.js";

type RelatedDocument = {
  distance: number;
  relationIds: string[];
  confidence: number;
};

/** Owns graph traversal and conversion from related documents to chunks. */
export default class RelationGraphTraversal {
  constructor(
    private readonly metadataStore: MetadataStoreContract,
    private readonly persistence: RelationGraphPersistence,
  ) {}

  async relatedDocumentKeys(
    starts: readonly string[],
    maxHops = 1,
    allowedDocumentKeys?: ReadonlySet<string>,
  ): Promise<Map<string, RelatedDocument>> {
    const limit = Math.max(0, Math.min(8, Math.trunc(maxHops)));
    const found = new Map<string, RelatedDocument>();
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
      const adjacent = this.buildAdjacent(
        frontier.map((item) => item.key),
        await this.persistence.relationsForKeys(frontier.map((item) => item.key)),
        allowedDocumentKeys,
      );
      const next: typeof frontier = [];
      for (const source of frontier) {
        for (const relation of adjacent.get(source.key) || []) {
          const previousDistance = bestDistance.get(relation.to);
          if (previousDistance !== undefined && previousDistance <= distance) continue;
          bestDistance.set(relation.to, distance);
          const confidence = Math.max(
            0,
            Math.min(
              1,
              source.confidence *
                Math.max(0, Math.min(1, Number(relation.confidence) || 0)),
            ),
          );
          const path = {
            key: relation.to,
            distance,
            relationIds: [...source.relationIds, relation.id],
            confidence,
          };
          next.push(path);
          const existing = found.get(relation.to);
          if (!existing || distance < existing.distance) {
            found.set(relation.to, {
              distance,
              relationIds: path.relationIds,
              confidence,
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
    if (typeof this.metadataStore.getFileByChunkId !== "function") return [];
    const starts: string[] = [];
    for (const chunkId of seedChunkIds) {
      const file = await this.metadataStore.getFileByChunkId(Number(chunkId));
      if (file) starts.push(...relationDocumentAliases(file));
    }
    const related = await this.relatedDocumentKeys(
      starts,
      maxHops,
      allowedDocumentKeys,
    );
    const results: RelatedChunk[] = [];
    for (const [documentKey, detail] of related) {
      const file = await this.resolveFile(documentKey);
      if (!file || typeof this.metadataStore.getChunksByFileId !== "function") continue;
      const chunks = await this.metadataStore.getChunksByFileId(file.id);
      for (const chunk of chunks || []) {
        const chunkId = Number(chunk.id);
        if (!Number.isFinite(chunkId)) continue;
        results.push({ chunkId, documentKey, ...detail });
        if (results.length >= Math.max(0, Math.round(maxAdded))) return results;
      }
    }
    return results;
  }

  private buildAdjacent(
    sourceKeys: readonly string[],
    relations: readonly MemoryRelation[],
    allowedDocumentKeys?: ReadonlySet<string>,
  ): Map<string, MemoryRelation[]> {
    const adjacent = new Map<string, MemoryRelation[]>();
    const sourceKeySet = new Set(sourceKeys);
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
    return adjacent;
  }

  private async resolveFile(documentKey: string): Promise<FileRow | null> {
    if (
      documentKey.startsWith("document:") &&
      typeof this.metadataStore.getFileByDocumentId === "function"
    ) {
      return this.metadataStore.getFileByDocumentId(
        documentKey.slice("document:".length),
      );
    }
    if (
      documentKey.startsWith("path:") &&
      typeof this.metadataStore.getFileByPath === "function"
    ) {
      const path = documentKey.slice("path:".length);
      const direct = await this.metadataStore.getFileByPath(path);
      if (direct) return direct;
      for (const suffix of [".mdx", ".md"]) {
        const candidate = await this.metadataStore.getFileByPath(`${path}${suffix}`);
        if (candidate) return candidate;
      }
    }
    return null;
  }
}
