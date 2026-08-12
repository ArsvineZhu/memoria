import type { MetadataStoreContract } from "../types/metadata.js";
import type {
  MemoryRelation,
  RelatedChunk,
  RelationGraphSnapshot,
} from "./relation-types.js";
import RelationGraphPersistence, {
  RELATION_GRAPH_KEY,
} from "./relation-graph-persistence.js";
import RelationGraphTraversal from "./relation-graph-traversal.js";

export { RELATION_GRAPH_KEY };

/** Compatibility facade for durable relation mutations and traversal. */
export class RelationGraphStore {
  private readonly persistence: RelationGraphPersistence;
  private readonly traversal: RelationGraphTraversal;
  private tail: Promise<void> = Promise.resolve();

  constructor(metadataStore: MetadataStoreContract) {
    this.persistence = new RelationGraphPersistence(metadataStore);
    this.traversal = new RelationGraphTraversal(metadataStore, this.persistence);
  }

  load(): Promise<RelationGraphSnapshot> {
    return this.persistence.load();
  }

  replaceSourceRelations(
    from: string,
    relations: readonly MemoryRelation[],
  ): Promise<RelationGraphSnapshot> {
    return this.enqueue(() => this.persistence.replaceSourceRelations(from, relations));
  }

  addDerivedRelations(
    relations: readonly (Omit<
      MemoryRelation,
      "id" | "origin" | "createdAt" | "updatedAt" | "status"
    > &
      Partial<
        Pick<MemoryRelation, "id" | "origin" | "createdAt" | "updatedAt" | "status">
      >)[],
  ): Promise<RelationGraphSnapshot> {
    return this.enqueue(() => this.persistence.addDerivedRelations(relations));
  }

  markSourceRelationsStale(from: string): Promise<RelationGraphSnapshot> {
    return this.enqueue(() => this.persistence.markSourceRelationsStale(from));
  }

  relatedDocumentKeys(
    starts: readonly string[],
    maxHops = 1,
    allowedDocumentKeys?: ReadonlySet<string>,
  ) {
    return this.traversal.relatedDocumentKeys(starts, maxHops, allowedDocumentKeys);
  }

  relatedChunks(
    seedChunkIds: readonly number[],
    maxHops = 1,
    maxAdded = 100,
    allowedDocumentKeys?: ReadonlySet<string>,
  ): Promise<RelatedChunk[]> {
    return this.traversal.relatedChunks(
      seedChunkIds,
      maxHops,
      maxAdded,
      allowedDocumentKeys,
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
