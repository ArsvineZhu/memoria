import type { MemoryRelationRecord } from "../types/relations.js";
import type { MetadataStoreContract } from "../types/metadata.js";

export type RelationKind = MemoryRelationRecord["kind"];
export type RelationOrigin = MemoryRelationRecord["origin"];
export type RelationStatus = MemoryRelationRecord["status"];
export type MemoryRelation = MemoryRelationRecord;

export interface RelationGraphSnapshot {
  schema: "relation-graph-v1";
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

export interface RelationGraphStoreOptions {
  metadataStore: MetadataStoreContract;
}
