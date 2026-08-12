import type {
  SourcePriority,
  UnknownRecord,
  Vector,
  VectorLike,
} from "../types/common.js";
import type { SearchResult } from "../types/documents.js";

export type Candidate = SearchResult & UnknownRecord;
export type ChunkVectorLoader = (chunkId: number) => Promise<VectorLike | null>;

export interface DeduplicatorConfig {
  dimension: number;
  semanticThreshold: number;
  maxResults: number;
  minSemanticCandidates: number;
  sourcePriority: SourcePriority;
}

export interface DeduplicateOptions {
  semantic?: boolean;
  semanticThreshold?: number;
  maxResults?: number;
  stage?: string;
}

export interface RankedCandidate {
  candidate: Candidate;
  index: number;
  vector: Vector | null;
}

export const DEFAULT_DEDUPLICATOR_CONFIG: DeduplicatorConfig = {
  dimension: 3072,
  semanticThreshold: 0.92,
  maxResults: 1000,
  minSemanticCandidates: 2,
  sourcePriority: {
    semantic: 50,
    time: 45,
    bm25Body: 40,
    bm25Tag: 40,
    continuity: 35,
    associate: 10,
    unknown: 0,
  },
};
