import type { UnknownRecord } from "./common.js";

export type MemoryRelationKind = "explicit-link" | "derived-link" | "tag" | "sequence";
export type MemoryRelationOrigin = "source" | "derived";
export type MemoryRelationStatus = "active" | "stale" | "rejected";

export interface MemoryRelationRecord {
  id: string;
  from: string;
  to: string;
  kind: MemoryRelationKind;
  origin: MemoryRelationOrigin;
  confidence: number;
  weight: number;
  evidence?: string | null;
  provenance?: UnknownRecord | null;
  sourceRevision?: string | null;
  algorithmVersion?: string | null;
  sourceSpan?: { start: number; end: number } | null;
  targetAnchor?: string | null;
  createdAt: number;
  updatedAt: number;
  status: MemoryRelationStatus;
  active: boolean;
}

export interface RelationListOptions {
  from?: string;
  to?: string;
  origins?: readonly MemoryRelationOrigin[];
  kinds?: readonly MemoryRelationKind[];
  statuses?: readonly MemoryRelationStatus[];
  includeInactive?: boolean;
}

export interface RelationStoreContract {
  replaceExplicitRelations?(
    from: string,
    sourceRevision: string,
    relations: readonly MemoryRelationRecord[],
  ): Promise<void>;
  upsertDerivedRelations?(
    relations: readonly (Omit<
      MemoryRelationRecord,
      "id" | "origin" | "createdAt" | "updatedAt" | "status"
    > &
      Partial<
        Pick<
          MemoryRelationRecord,
          "id" | "origin" | "createdAt" | "updatedAt" | "status"
        >
      >)[],
  ): Promise<void>;
  listRelations?(options?: RelationListOptions): Promise<MemoryRelationRecord[]>;
  markExplicitRelationsStale?(from: string): Promise<void>;
  getRelationGeneration?(): Promise<number>;
  getRelationReadinessStats?(): Promise<{
    explicitLinks: number;
    activeInferredLinks: number;
  }>;
  getAdjacentRelations?(
    documentKeys: readonly string[],
  ): Promise<MemoryRelationRecord[]>;
}
