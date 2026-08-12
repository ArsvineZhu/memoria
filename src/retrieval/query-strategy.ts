import {
  normalizeRetrievalPlan,
  type RetrievalPlan,
  type RetrievalPlanInput,
  type RetrievalStrategy,
} from "./retrieval-plan.js";
import type {
  GraphReadiness,
  QueryPlanningOptions,
  QueryProfile,
  RetrievalDecision,
  StrategyDecision,
} from "./query-planner-types.js";
import { mergeGraphReadiness } from "./query-readiness.js";

function automaticPlanFor(
  profile: QueryProfile,
  strategy: Exclude<RetrievalStrategy, "auto">,
): RetrievalPlan {
  const structural = strategy === "structural";
  const associative = strategy === "associative";
  return normalizeRetrievalPlan({
    strategy,
    associative: {
      enabled: associative || structural,
      tagBasisProjection: associative || structural,
      tagResidualDecomposition: associative || structural,
      tagGraphPropagation: associative || structural,
      propagationSupport: associative || structural,
      tagExpansion: profile.signals.topical,
    },
    structural: {
      enabled: structural,
      propagationStructure: structural,
      relationExpansion: structural,
    },
    propagationHistory: { enabled: false },
    expansion: {
      related: structural || profile.wantsRelatedContext,
      maxHops: structural ? (profile.signals.sequence ? 2 : 1) : 0,
      sameDocument: profile.wantsDirectEvidence,
      maxAdded: structural ? 100 : 50,
    },
    postprocess: {
      timeDecay: profile.timeConstraints !== null || profile.signals.temporal,
      dedupe: true,
    },
  });
}

export function chooseStrategy(
  profile: QueryProfile,
  readiness: Partial<GraphReadiness> = {},
  plan: RetrievalPlan = normalizeRetrievalPlan(),
): StrategyDecision {
  const graph = mergeGraphReadiness(readiness);
  if (plan.strategy !== "auto") {
    return {
      strategy: plan.strategy,
      scores: {
        semantic: 0,
        associative: plan.strategy === "associative" ? 1 : 0,
        structural: plan.strategy === "structural" ? 1 : 0,
      },
      reasons: [`explicit strategy override: ${plan.strategy}`],
    };
  }

  const scores = {
    semantic: 1 + profile.complexity * 0.15,
    associative: profile.signals.topical ? 2 : 0,
    structural:
      profile.wantsRelatedContext || profile.signals.directReference
        ? 2
        : profile.signals.relational || profile.signals.sequence
          ? 1.5
          : 0,
  };
  const reasons: string[] = [];
  if (profile.signals.topical)
    reasons.push("topic/tag concepts raise associative score");
  if (profile.wantsRelatedContext)
    reasons.push("relation intent raises structural score");
  if (profile.wantsDirectEvidence) {
    reasons.push("direct-evidence intent preserves structural anchors");
  }
  if (graph.explicitLinks > 0 || graph.activeInferredLinks > 0) {
    scores.structural += Math.min(
      1,
      (graph.explicitLinks + graph.activeInferredLinks) / 100,
    );
    reasons.push("durable relation graph is available");
  }
  if (!graph.permissionScopeReady) {
    scores.structural = 0;
    reasons.push("permission scope is not ready; structural retrieval is gated");
  }
  const ranked = (
    Object.entries(scores) as Array<[Exclude<RetrievalStrategy, "auto">, number]>
  ).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const strategy = ranked[0]?.[0] || "semantic";
  if (strategy === "structural" && !graph.tagGraphArtifactReady) {
    return {
      strategy: "semantic",
      scores,
      reasons: [
        ...reasons,
        "tag association graph artifact is unavailable; semantic fallback selected",
      ],
      fallback: "tag association graph artifact unavailable",
    };
  }
  if (reasons.length === 0) reasons.push("semantic is the stable default");
  return { strategy, scores, reasons };
}

function mergeAutoPlan(
  base: RetrievalPlan,
  overlay: RetrievalPlanInput,
): RetrievalPlan {
  return normalizeRetrievalPlan({
    ...base,
    ...overlay,
    strategy: base.strategy,
    associative: { ...base.associative, ...(overlay.associative || {}) },
    structural: { ...base.structural, ...(overlay.structural || {}) },
    propagationHistory: {
      ...base.propagationHistory,
      ...(overlay.propagationHistory || {}),
    },
    filters: overlay.filters ?? base.filters,
    externalRerank: { ...base.externalRerank, ...(overlay.externalRerank || {}) },
    expansion: { ...base.expansion, ...(overlay.expansion || {}) },
    postprocess: { ...base.postprocess, ...(overlay.postprocess || {}) },
  });
}

export function planFromProfile(
  profile: QueryProfile,
  options: QueryPlanningOptions,
): RetrievalDecision {
  const readiness = mergeGraphReadiness(options.readiness);
  const supplied = options.plan;
  const normalized = normalizeRetrievalPlan(supplied);
  const decision = chooseStrategy(profile, readiness, normalized);
  const automatic = automaticPlanFor(profile, decision.strategy);
  const plan =
    supplied && supplied.strategy === "auto"
      ? mergeAutoPlan(automatic, supplied)
      : supplied && supplied.strategy !== "auto"
        ? normalized
        : automatic;
  return {
    plan,
    profile,
    reason: decision.reasons.join("; "),
    confidence: profile.confidence,
    explicit: supplied?.strategy !== undefined && supplied.strategy !== "auto",
    decision,
    readiness,
  };
}
