import type { ChunkCandidate } from "../../types/documents.js";
import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";
import type { PropagationSupportData } from "../../types/retrieval.js";

export type NativePropagationSupportFailure =
  "backend_unavailable" | "artifact_unavailable" | "invalid_result";

export type ScoredCandidate = {
  candidate: ChunkCandidate;
  chunkId: number;
  originalScore: number;
  supportScore: number;
  hitCount: number;
};

export interface NativeRerankResult {
  output?: PipelineData;
  reason?: NativePropagationSupportFailure;
  failure?: NativePropagationSupportFailure;
}

export interface SupportRerankOptions {
  alpha: number;
  minSupportSamples: number;
}

export interface SupportRerankContext {
  info: PipelineData;
  ctx: PipelineContextLike;
  options: SupportRerankOptions;
}

export type SupportRerankOutput = Omit<
  PipelineData,
  "mergedCandidates" | "propagationSupport"
> & {
  mergedCandidates: ChunkCandidate[];
  propagationSupport?: PropagationSupportData;
  propagationSupportSkipped?: boolean;
};
