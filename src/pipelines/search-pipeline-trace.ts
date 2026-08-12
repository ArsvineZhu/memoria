import type Pipeline from "../core/pipeline.js";
import type {
  RetrievalDiagnostics,
  RetrievalEvidenceChannel,
  RetrievalFallbackReason,
} from "../types/documents.js";
import type { PipelineData } from "../types/pipeline.js";
import type { RetrievalExplanation } from "../retrieval/query-planner.js";

function fallbackReason(key: string, reason: unknown): RetrievalFallbackReason {
  const reasonText = typeof reason === "string" ? reason : "";
  const value = `${key} ${reasonText}`.toLowerCase();
  if (value.includes("native") && value.includes("fail")) {
    return "native-backend-failed";
  }
  if (value.includes("history") && value.includes("persist")) {
    return "history-persistence-failed";
  }
  if (value.includes("artifact")) return "artifact-unavailable";
  if (value.includes("invalid")) return "invalid-result";
  if (value.includes("provider") || value.includes("error")) {
    return "provider-error";
  }
  if (value.includes("backend") || value.includes("native")) {
    return "backend-unavailable";
  }
  if (value.includes("capability") || value.includes("history")) {
    return "capability-unavailable";
  }
  return "disabled-by-plan";
}

function evidence(output: PipelineData): RetrievalDiagnostics["evidence"] {
  const channels: Array<[RetrievalEvidenceChannel, boolean]> = [
    [
      "semantic",
      Array.isArray(output.vectorResults) ||
        Array.isArray(output.queryVector) ||
        Array.isArray(output.mergedCandidates),
    ],
    ["lexical", Array.isArray(output.bm25Results)],
    [
      "tag-association",
      output.tagGraphPropagation !== undefined ||
        output.tagBasisProjection !== undefined ||
        output.tagResidualDecomposition !== undefined,
    ],
    [
      "relation-expansion",
      output.expansionStats !== undefined || output.relationExpansion !== undefined,
    ],
    ["support", output.propagationSupport !== undefined],
    ["structure", output.propagationStructure !== undefined],
  ];
  return channels
    .filter(([, available]) => available)
    .map(([channel, available]) => ({ channel, available }));
}

/** Projects internal stage outcomes into stable, capability-level diagnostics. */
export function withRetrievalTrace(
  output: PipelineData,
  _activePipeline: Pipeline,
  resolution: RetrievalExplanation,
): PipelineData {
  const fallbacks = new Set<RetrievalFallbackReason>();
  for (const [key, value] of Object.entries(output)) {
    if (!key.endsWith("Skipped") || value !== true) continue;
    const reasonKey = `${key.slice(0, -"Skipped".length)}SkipReason`;
    fallbacks.add(fallbackReason(key, output[reasonKey]));
  }

  return {
    ...output,
    retrieval: {
      strategy: String(resolution.decision.strategy || resolution.plan.strategy),
      strategySource: resolution.strategySource,
      plan: resolution.plan,
      evidence: evidence(output),
      fallbacks: [...fallbacks],
    },
  };
}
