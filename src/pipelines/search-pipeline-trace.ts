import type Pipeline from "../core/pipeline.js";
import type { PipelineData } from "../types/pipeline.js";
import type { RetrievalExplanation } from "../retrieval/query-planner.js";

/** Adds stable retrieval diagnostics without changing the result payload. */
export function withRetrievalTrace(
  output: PipelineData,
  activePipeline: Pipeline,
  resolution: RetrievalExplanation,
): PipelineData {
  const fallbacks: string[] = [];
  for (const [key, value] of Object.entries(output)) {
    if (!key.endsWith("Skipped") || value !== true) continue;
    const reasonKey = `${key.slice(0, -"Skipped".length)}SkipReason`;
    const reason = output[reasonKey];
    fallbacks.push(
      `${key.slice(0, -"Skipped".length)}: ${
        typeof reason === "string" ? reason : "skipped"
      }`,
    );
  }
  return {
    ...output,
    retrievalTrace: {
      defaultPlan: resolution.defaultPlan,
      requestedPlan: resolution.requestedPlan || undefined,
      plan: resolution.plan,
      profile: resolution.profile,
      decision: resolution.decision,
      strategySource: resolution.strategySource,
      defaultsInherited: resolution.defaultsInherited,
      queryOverrideApplied: resolution.queryOverrideApplied,
      stageOrder: activePipeline.stages.map((stage) => stage.name || "anonymous"),
      fallbacks,
    },
  };
}
