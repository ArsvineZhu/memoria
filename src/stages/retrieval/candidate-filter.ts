import type { ChunkCandidate } from "../../types/documents.js";
import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";

import Stage from "../../core/stage.js";

/** Re-applies the resolved immutable filter to all later candidate additions. */
class CandidateFilterStage extends Stage {
  constructor() {
    super();
    this.name = "candidateFilter";
  }

  override async process(
    input: PipelineData,
    _ctx: PipelineContextLike,
  ): Promise<PipelineData> {
    const info = input || {};
    const candidates = Array.isArray(info.mergedCandidates)
      ? (info.mergedCandidates as ChunkCandidate[])
      : [];
    const allowed = info.allowedChunkIds;
    if (!(allowed instanceof Set)) return { ...info, mergedCandidates: candidates };
    const filtered = candidates.filter((candidate) =>
      allowed.has(Number(candidate.chunkId)),
    );
    return {
      ...info,
      mergedCandidates: filtered,
      retrievalFilter: {
        ...(typeof info.retrievalFilter === "object" && info.retrievalFilter !== null
          ? info.retrievalFilter
          : {}),
        finalCandidates: filtered.length,
      },
    };
  }
}

export default CandidateFilterStage;
