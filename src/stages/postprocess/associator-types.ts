import type { ChunkCandidate, VectorHit } from "../../types/documents.js";
import type { FileRow } from "../../types/metadata.js";
import type { PipelineContextLike } from "../../types/pipeline.js";
import type { AssociatorStats } from "../../types/retrieval.js";

export type AssociationChannel = "tag" | "vector";

export interface AssociationProposal {
  chunkId: number;
  score: number;
  channel: AssociationChannel;
  seedChunkId: number;
}

export interface AssociationChannelContext {
  scope: Set<string> | null;
  allowedChunkIds: Set<unknown> | null;
  ctx: PipelineContextLike;
  proposals: Map<number, AssociationProposal>;
  presentIds: Set<number>;
  stats: AssociatorStats;
}

export interface AssociatorSeedContext extends AssociationChannelContext {
  seed: ChunkCandidate;
}

export type AssociatorVectorHits = VectorHit[];
export type AssociatorFile = FileRow;
