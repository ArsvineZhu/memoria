import type {
  MemoryConfig,
  MemoryConfigOverrides,
  SearchOptions,
} from "../types/config.js";
import type { PipelineContextLike, PipelineData } from "../types/pipeline.js";
import type { RetrievalExplanation } from "../retrieval/query-planner.js";
import type { RetrievalPlan } from "../retrieval/retrieval-plan.js";

export interface SearchRunPreparationOptions {
  source: PipelineData;
  options: SearchOptions;
  ctx: Partial<PipelineContextLike>;
  runConfig: MemoryConfigOverrides;
  resolution: RetrievalExplanation;
  defaultRetrievalPlan: RetrievalPlan;
}

export interface PreparedSearchRun {
  payload: PipelineData;
  context: PipelineContextLike;
  tagAssociationGraphLoadError?: string;
}

/** Assemble per-run context and the canonical diagnostic payload. */
export async function prepareSearchRun(
  input: SearchRunPreparationOptions,
): Promise<PreparedSearchRun> {
  const { source, options, ctx, runConfig, resolution, defaultRetrievalPlan } = input;
  let tagAssociationGraph = ctx.tagAssociationGraph;
  let tagAssociationGraphLoadError: string | undefined;
  if (
    !(tagAssociationGraph instanceof Map) &&
    runConfig.tagGraphPropagationEnabled === true &&
    typeof ctx.metadataStore?.buildCooccurrenceMatrix === "function"
  ) {
    try {
      tagAssociationGraph = await ctx.metadataStore.buildCooccurrenceMatrix();
    } catch (error) {
      tagAssociationGraph = new Map();
      tagAssociationGraphLoadError =
        error instanceof Error ? error.message : String(error);
    }
  }
  const propagationHistoryStore =
    ctx.propagationHistoryStore ||
    (typeof ctx.metadataStore?.readPropagationHistory === "function" &&
    typeof ctx.metadataStore?.commitPropagationObservation === "function"
      ? {
          readPropagationHistory: ctx.metadataStore.readPropagationHistory.bind(
            ctx.metadataStore,
          ),
          commitPropagationObservation:
            ctx.metadataStore.commitPropagationObservation.bind(ctx.metadataStore),
        }
      : undefined);
  const context: PipelineContextLike = {
    ...ctx,
    config: runConfig as MemoryConfig,
    tagAssociationGraph,
    propagationHistoryStore,
  };

  const payload = { ...source };
  Object.assign(payload, options, {
    query: source.query,
    retrievalPlan: resolution.plan,
    defaultRetrievalPlan,
    requestedRetrievalPlan: resolution.requestedPlan || undefined,
    queryProfile: resolution.profile,
    retrievalDecision: {
      strategy: resolution.decision.strategy,
      scores: resolution.decision.scores,
      reasons: resolution.decision.reasons,
      fallback: resolution.decision.fallback,
      reason: resolution.reason,
      confidence: resolution.confidence,
      explicit: resolution.explicit,
      strategySource: resolution.strategySource,
      defaultsInherited: resolution.defaultsInherited,
      queryOverrideApplied: resolution.queryOverrideApplied,
    },
  });
  if (tagAssociationGraphLoadError) {
    payload.tagAssociationGraphLoadError = tagAssociationGraphLoadError;
  }
  return { payload, context, tagAssociationGraphLoadError };
}

export function mergeRunOptions(
  source: PipelineData,
  options: SearchOptions,
): SearchOptions {
  return {
    ...options,
    retrievalPlan: options.retrievalPlan ?? source.retrievalPlan,
  };
}
