import type { ChunkCandidate } from "../../types/documents.js";
import type { MemoryConfigOverrides } from "../../types/config.js";
import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";
import type { PropagationStructureData } from "../../types/retrieval.js";
import Stage from "../../core/stage.js";
import PropagationStructureNativeAdapter from "./propagation-structure-native.js";
import { rankPropagationStructure } from "./propagation-structure-scoring.js";

/** Orchestrates native propagation-structure ranking with the local fallback. */
class PropagationStructureRerankerStage extends Stage {
  private readonly native = new PropagationStructureNativeAdapter();

  constructor() {
    super();
    this.name = "propagationStructureReranker";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "propagationStructure" | "mergedCandidates"> & {
      propagationStructure?: PropagationStructureData;
      mergedCandidates?: ChunkCandidate[];
      propagationStructureSkipped?: boolean;
    }
  > {
    let info = input || {};
    if (ctx.config.propagationStructureRerankEnabled !== true) {
      return { ...info, propagationStructureSkipped: true };
    }

    if (
      ctx.config.nativeTagRetrievalEnabled === true &&
      info.tagRetrievalSkipped === false
    ) {
      const native = await this.native.rerank(info, ctx);
      if (native.output) {
        return {
          ...native.output,
          mergedCandidates: (Array.isArray(native.output.mergedCandidates)
            ? native.output.mergedCandidates
            : info.mergedCandidates || []) as ChunkCandidate[],
        };
      }
      if (native.reason) {
        info = {
          ...info,
          propagationStructureNativeSkipped: true,
          propagationStructureNativeSkipReason: native.reason,
          propagationStructureNativeFailure: native.failure,
        };
      }
    }

    const local = rankPropagationStructure(info, ctx.config as MemoryConfigOverrides);
    return {
      ...info,
      propagationStructure: {
        schema: "propagation-structure-v1",
        spreadClass: local.spreadClass,
        spreadScore: local.spreadScore,
        historySupport: local.historySupport,
        nodeTotals: local.nodeTotals,
        activeEdges: local.activeEdges,
        nodeCount: local.nodeCount,
        edgeCount: local.edgeCount,
        rerankedCount: local.mergedCandidates.length,
      },
      mergedCandidates: local.mergedCandidates,
    };
  }
}

export default PropagationStructureRerankerStage;
