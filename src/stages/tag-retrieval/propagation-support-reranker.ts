import type { ChunkCandidate } from "../../types/documents.js";
import type { ResolvedMemoryConfigOverrides } from "../../types/config.js";
import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";

import Stage from "../../core/stage.js";
import { rerankNative } from "./propagation-support-native.js";
import {
  applySupportScores,
  emptySupportData,
  scoreCandidates,
} from "./propagation-support-scoring.js";
import type { SupportRerankOutput } from "./propagation-support-types.js";

const DEFAULT_ALPHA = 0.3;
const DEFAULT_MIN_SUPPORT_SAMPLES = 4;

/** Stage facade: native-first dispatch with a deterministic TypeScript fallback. */
class PropagationSupportRerankerStage extends Stage {
  constructor() {
    super();
    this.name = "propagationSupportReranker";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<SupportRerankOutput> {
    let info = input || {};
    const candidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];
    const config = ctx.config || {};
    const alpha = this.alpha(config);
    const minSupportSamples = this.minSupportSamples(config);

    if (config.propagationSupportRerankEnabled !== true) {
      return { ...info, mergedCandidates: candidates, propagationSupportSkipped: true };
    }

    if (
      config.nativeTagRetrievalEnabled === true &&
      info.tagRetrievalObservation?.source === "native"
    ) {
      const native = await rerankNative(info, ctx, alpha, minSupportSamples);
      if (native.output) {
        return {
          ...native.output,
          mergedCandidates: (Array.isArray(native.output.mergedCandidates)
            ? native.output.mergedCandidates
            : candidates) as ChunkCandidate[],
        };
      }
      if (native.reason) {
        info = {
          ...info,
          propagationSupportNativeSkipped: true,
          propagationSupportNativeSkipReason: native.reason,
          propagationSupportNativeFailure: native.failure,
        };
      }
    }

    const activations = info.tagGraphPropagation?.activations;
    if (
      !(activations instanceof Map) ||
      activations.size === 0 ||
      candidates.length === 0
    ) {
      return {
        ...info,
        mergedCandidates: candidates,
        propagationSupport: emptySupportData(alpha, minSupportSamples),
        propagationSupportSkipped: true,
      };
    }

    const scored = await scoreCandidates(
      candidates,
      activations,
      minSupportSamples,
      new Map<string, number | null>(),
      ctx,
    );
    const maxSupportScore = Math.max(
      0,
      ...scored.scored.map((item) => (item.supportScore > 0 ? item.supportScore : 0)),
    );
    if (!(maxSupportScore > 0)) {
      return {
        ...info,
        mergedCandidates: candidates,
        propagationSupport: {
          schema: "tag-association-transition-v1",
          algorithmVersion: "tag-association-transition-typescript",
          alpha,
          minSupportSamples,
          appliedCount: 0,
          degradedCount: scored.degradedCount,
          scores: scored.observedScores,
        },
        propagationSupportSkipped: true,
      };
    }

    const observedScores = scored.observedScores ?? [];
    for (const observed of observedScores) {
      observed.normalizedSupportScore =
        maxSupportScore > 0 && observed.supportScore > 0
          ? observed.supportScore / maxSupportScore
          : 0;
    }
    const applied = applySupportScores(scored.scored, observedScores, alpha);
    return {
      ...info,
      mergedCandidates: applied.reranked,
      propagationSupport: {
        schema: "tag-association-transition-v1",
        algorithmVersion: "tag-association-transition-typescript",
        alpha,
        minSupportSamples,
        appliedCount: applied.appliedCount,
        degradedCount: scored.degradedCount,
        scores: observedScores,
      },
    };
  }

  private alpha(config: ResolvedMemoryConfigOverrides): number {
    const value = Number(config.supportRerankAlpha);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_ALPHA;
  }

  private minSupportSamples(config: ResolvedMemoryConfigOverrides): number {
    const value = Number(config.supportRerankMinSamples);
    return Number.isFinite(value)
      ? Math.max(1, Math.round(value))
      : DEFAULT_MIN_SUPPORT_SAMPLES;
  }
}

export default PropagationSupportRerankerStage;
