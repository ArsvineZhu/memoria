"use strict";

import {
  normalizeRetrievalPlan,
  type RetrievalPlan,
  type RetrievalPlanInput,
  type RetrievalStrategy,
} from "./retrieval-plan.js";
import type { PipelineContextLike, UnknownRecord } from "../types.js";

export interface QueryProfileSignals {
  relational: boolean;
  sequence: boolean;
  temporal: boolean;
  topical: boolean;
  directReference: boolean;
  question: boolean;
}

export interface QueryProfile {
  raw: string;
  normalized: string;
  tokens: string[];
  concepts: string[];
  entities: string[];
  relationHints: string[];
  timeConstraints: UnknownRecord | null;
  wantsDirectEvidence: boolean;
  wantsRelatedContext: boolean;
  complexity: number;
  confidence: number;
  signals: QueryProfileSignals;
}

export interface QueryInterpreter {
  interpret(query: string): Promise<Partial<QueryProfile>> | Partial<QueryProfile>;
}

export interface GraphReadiness {
  explicitLinks: number;
  activeInferredLinks: number;
  candidatePathCount: number;
  topologyArtifactReady: boolean;
  permissionScopeReady: boolean;
}

export interface StrategyDecision {
  strategy: Exclude<RetrievalStrategy, "auto">;
  scores: Record<"semantic" | "field" | "topology", number>;
  reasons: string[];
  fallback?: string;
}

export interface QueryPlanningOptions {
  plan?: RetrievalPlanInput | null;
  hints?: Partial<QueryProfile>;
  readiness?: Partial<GraphReadiness>;
  interpreter?: QueryInterpreter;
}

export type RetrievalStrategySource = "engine-default" | "query-override" | "auto";

export interface RetrievalDecision {
  plan: RetrievalPlan;
  profile: QueryProfile;
  reason: string;
  confidence: number;
  explicit: boolean;
  decision: StrategyDecision;
  readiness: GraphReadiness;
  /** Present when the decision was resolved through an engine search entry. */
  strategySource?: RetrievalStrategySource;
  defaultsInherited?: boolean;
  queryOverrideApplied?: boolean;
}

export interface RetrievalExplanation extends RetrievalDecision {
  defaultPlan: RetrievalPlan;
  requestedPlan?: RetrievalPlanInput;
  strategySource: RetrievalStrategySource;
  defaultsInherited: boolean;
  queryOverrideApplied: boolean;
}

const SIGNAL_PATTERNS: Record<keyof QueryProfileSignals, RegExp> = {
  relational:
    /关联|相关|联系|连接|指向|依赖|因果|来源|为什么|因为|链路|关系|related|relate|connect|link|depend|cause|because/i,
  sequence:
    /路径|沿着|连续|演化|脉络|时间线|顺序|前后|轨迹|sequence|path|timeline|before|after|trajectory/i,
  temporal:
    /最近|今天|昨日|昨天|明天|现在|之前|以后|历史|时间|何时|latest|recent|today|yesterday|when|time/i,
  topical: /标签|主题|概念|关键词|类别|分类|tag|topic|concept|keyword|category/i,
  directReference: /这份|该文|这段|原文|直接|锚点|引用|source|direct|anchor|exact/i,
  question:
    /[?？]|如何|什么|哪些|为何|请找|查找|寻找|解释|why|what|how|which|find|search/i,
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

const RELATION_HINTS = [
  "关联",
  "相关",
  "联系",
  "连接",
  "指向",
  "依赖",
  "因果",
  "来源",
  "链路",
  "关系",
  "路径",
  "沿着",
  "related",
  "connect",
  "depend",
  "cause",
  "source",
  "path",
];

// These words describe the requested retrieval operation rather than the
// memory concept. Splitting on them prevents a sliding CJK n-gram tokenizer
// from turning a phrase such as "关系路径" into misleading fragments like
// "系路". The split is only used for the planner profile; the original query
// still goes unchanged to embedding and BM25 stages.
const CJK_CONCEPT_BOUNDARY =
  /沿着|关联|相关|联系|连接|指向|依赖|因果|来源|为什么|因为|链路|关系|路径|连续|演化|脉络|时间线|顺序|前后|轨迹|最近|今天|昨日|昨天|明天|现在|之前|以后|历史|时间|何时|标签|主题|概念|关键词|类别|分类|这份|该文|这段|原文|直接|锚点|引用|如何|什么|哪些|为何|请找|查找|寻找|解释|的|与|和|及|在|是|了|着|从|为|将|被|对/g;

function tokenizeQuery(normalized: string): string[] {
  const tokens: string[] = [];
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_.:/@#-]*/gi)) {
    tokens.push(match[0].toLowerCase());
  }

  for (const match of normalized.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = match[0];
    tokens.push(run);
    const chars = [...run];
    // Include short CJK phrases so the profile retains meaningful concepts
    // without requiring a language-specific tokenizer.
    for (let width = 2; width <= Math.min(8, chars.length); width += 1) {
      for (let index = 0; index + width <= chars.length; index += 1) {
        tokens.push(chars.slice(index, index + width).join(""));
      }
    }
  }

  return unique(tokens);
}

function extractConcepts(
  tokens: readonly string[],
  _signals: QueryProfileSignals,
  normalized: string,
): string[] {
  const cueWords =
    /沿着|关联|相关|联系|连接|指向|依赖|因果|来源|为什么|因为|链路|关系|路径|连续|演化|脉络|时间线|顺序|前后|轨迹|最近|今天|昨日|昨天|明天|现在|之前|以后|历史|时间|何时|标签|主题|概念|关键词|类别|分类|这份|该文|这段|原文|直接|锚点|引用|如何|什么|哪些|为何|请找|查找|寻找|解释/;
  const cjkConcepts: string[] = [];
  for (const match of normalized.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = match[0] || "";
    const segments = run
      .split(CJK_CONCEPT_BOUNDARY)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length >= 2);
    for (const segment of segments) {
      cjkConcepts.push(segment);
      const chars = [...segment];
      for (let width = 2; width <= Math.min(8, chars.length); width += 1) {
        for (let index = 0; index + width <= chars.length; index += 1) {
          cjkConcepts.push(chars.slice(index, index + width).join(""));
        }
      }
    }
  }

  const nonCjkConcepts = tokens.filter(
    (token) =>
      !/^[\u4e00-\u9fff]+$/.test(token) &&
      token.length >= 2 &&
      !cueWords.test(token) &&
      !/^\d+$/.test(token),
  );
  return unique([...cjkConcepts, ...nonCjkConcepts]).slice(0, 32);
}

function extractEntities(normalized: string, tokens: readonly string[]): string[] {
  const quoted = [...normalized.matchAll(/["“”']([^"“”']{2,80})["“”']/g)].map(
    (match) => match[1] || "",
  );
  const pathLike = tokens.filter(
    (token) => /\.(?:md|mdx|txt)$/i.test(token) || /^memory(?::|:\/\/)/i.test(token),
  );
  return unique([...quoted, ...pathLike]).slice(0, 24);
}

function extractTimeConstraints(normalized: string): UnknownRecord | null {
  const relative = normalized.match(
    /(?:最近|近来|今天|昨日|昨天|明天|上周|本周|去年|今年|过去\s*\d+\s*(?:天|周|月|年)|最近\s*\d+\s*(?:天|周|月|年)|last\s+\d+\s+(?:days?|weeks?|months?|years?))/i,
  )?.[0];
  if (!relative) return null;
  return { expression: relative, kind: "relative" };
}

function defaultReadiness(): GraphReadiness {
  return {
    explicitLinks: 0,
    activeInferredLinks: 0,
    candidatePathCount: 0,
    topologyArtifactReady: true,
    permissionScopeReady: true,
  };
}

function mergeReadiness(input: Partial<GraphReadiness> | undefined): GraphReadiness {
  return { ...defaultReadiness(), ...(input || {}) };
}

/** Turn an ordinary natural-language query into planner-visible signals. */
export function profileNaturalLanguageQuery(
  query: string,
  hints: Partial<QueryProfile> = {},
): QueryProfile {
  const raw = String(query ?? "");
  const normalized = raw.trim().replace(/\s+/g, " ");
  const signals = Object.fromEntries(
    (Object.keys(SIGNAL_PATTERNS) as Array<keyof QueryProfileSignals>).map((key) => [
      key,
      SIGNAL_PATTERNS[key].test(normalized),
    ]),
  ) as unknown as QueryProfileSignals;
  const tokens = tokenizeQuery(normalized);
  const concepts = unique([
    ...extractConcepts(tokens, signals, normalized),
    ...(Array.isArray(hints.concepts) ? hints.concepts : []),
  ]).slice(0, 64);
  const relationHints = unique(
    RELATION_HINTS.filter((hint) =>
      normalized.toLowerCase().includes(hint.toLowerCase()),
    ),
  );
  const timeConstraints =
    hints.timeConstraints === undefined
      ? extractTimeConstraints(normalized)
      : hints.timeConstraints;
  const wantsDirectEvidence = hints.wantsDirectEvidence ?? signals.directReference;
  const wantsRelatedContext =
    hints.wantsRelatedContext ?? (signals.relational || signals.sequence);
  const complexity =
    hints.complexity ??
    Math.min(1, (tokens.length + concepts.length + relationHints.length * 2) / 32);
  const confidence =
    hints.confidence ??
    Math.min(0.99, 0.55 + Object.values(signals).filter(Boolean).length * 0.08);
  return {
    raw,
    normalized,
    tokens,
    concepts,
    entities: unique([
      ...extractEntities(normalized, tokens),
      ...(Array.isArray(hints.entities) ? hints.entities : []),
    ]).slice(0, 24),
    relationHints: unique([
      ...relationHints,
      ...(Array.isArray(hints.relationHints) ? hints.relationHints : []),
    ]).slice(0, 24),
    timeConstraints,
    wantsDirectEvidence,
    wantsRelatedContext,
    complexity,
    confidence,
    signals,
  };
}

function automaticPlanFor(
  profile: QueryProfile,
  strategy: Exclude<RetrievalStrategy, "auto">,
): RetrievalPlan {
  const topology = strategy === "topology";
  const field = strategy === "field";
  return normalizeRetrievalPlan({
    strategy,
    field: {
      enabled: field,
      geodesicRerank: field,
    },
    tagMemo: {
      enabled: field,
      plus: field,
      version: "v10",
      geodesicRerank: field,
    },
    topology: {
      enabled: topology,
      version: "v3",
      maxHops: topology ? (profile.signals.sequence ? 3 : 2) : 0,
      relatedExpansion: topology,
    },
    riverMemo: {
      enabled: topology,
      rerank: topology,
      version: "v3",
      maxHops: topology ? (profile.signals.sequence ? 3 : 2) : 0,
    },
    expansion: {
      related: topology || profile.wantsRelatedContext,
      maxHops: topology ? (profile.signals.sequence ? 2 : 1) : 0,
      sameDocument: profile.wantsDirectEvidence,
      maxAdded: topology ? 100 : 50,
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
  const graph = mergeReadiness(readiness);
  if (plan.strategy !== "auto") {
    return {
      strategy: plan.strategy,
      scores: {
        semantic: 0,
        field: plan.strategy === "field" ? 1 : 0,
        topology: plan.strategy === "topology" ? 1 : 0,
      },
      reasons: [`explicit strategy override: ${plan.strategy}`],
    };
  }

  const scores = {
    semantic: 1 + profile.complexity * 0.15,
    field: profile.signals.topical ? 2 : 0,
    topology:
      profile.wantsRelatedContext || profile.signals.directReference
        ? 2
        : profile.signals.relational || profile.signals.sequence
          ? 1.5
          : 0,
  };
  const reasons: string[] = [];
  if (profile.signals.topical) reasons.push("topic/tag concepts raise field score");
  if (profile.wantsRelatedContext)
    reasons.push("relation intent raises topology score");
  if (profile.wantsDirectEvidence)
    reasons.push("direct-evidence intent preserves topology anchors");
  if (graph.explicitLinks > 0 || graph.activeInferredLinks > 0) {
    scores.topology += Math.min(
      1,
      (graph.explicitLinks + graph.activeInferredLinks) / 100,
    );
    reasons.push("durable relation graph is available");
  }
  if (!graph.permissionScopeReady) {
    scores.topology = 0;
    reasons.push("permission scope is not ready; topology is gated");
  }
  const ranked = (
    Object.entries(scores) as Array<[Exclude<RetrievalStrategy, "auto">, number]>
  ).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const strategy = ranked[0]?.[0] || "semantic";
  if (strategy === "topology" && !graph.topologyArtifactReady) {
    return {
      strategy: "semantic",
      scores,
      reasons: [
        ...reasons,
        "topology artifact is unavailable; semantic fallback selected",
      ],
      fallback: "topology artifact unavailable",
    };
  }
  if (reasons.length === 0) reasons.push("semantic is the stable default");
  return { strategy, scores, reasons };
}

function mergeAutoPlan(base: RetrievalPlan, overlay: RetrievalPlan): RetrievalPlan {
  return normalizeRetrievalPlan({
    ...base,
    ...overlay,
    strategy: base.strategy,
    field: { ...base.field, ...(overlay.field || {}) },
    topology: { ...base.topology, ...(overlay.topology || {}) },
    tagMemo: { ...base.tagMemo, ...(overlay.tagMemo || {}) },
    riverMemo: { ...base.riverMemo, ...(overlay.riverMemo || {}) },
    filters: overlay.filters ?? base.filters,
    externalRerank: { ...base.externalRerank, ...(overlay.externalRerank || {}) },
    expansion: { ...base.expansion, ...(overlay.expansion || {}) },
    postprocess: { ...base.postprocess, ...(overlay.postprocess || {}) },
  });
}

function planFromProfile(
  profile: QueryProfile,
  options: QueryPlanningOptions,
): RetrievalDecision {
  const readiness = mergeReadiness(options.readiness);
  const supplied = options.plan;
  const normalized = normalizeRetrievalPlan(supplied);
  const decision = chooseStrategy(profile, readiness, normalized);
  const automatic = automaticPlanFor(profile, decision.strategy);
  const plan =
    supplied && supplied.strategy === "auto"
      ? mergeAutoPlan(automatic, normalized)
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

/**
 * Select the library-native retrieval strategy from a query profile.
 *
 * This function deliberately consumes only ordinary text and a typed API
 * override. It does not inspect MDX, prompt placeholders, or source syntax.
 */
export function planRetrieval(
  query: string,
  options: QueryPlanningOptions = {},
): RetrievalDecision {
  return planFromProfile(profileNaturalLanguageQuery(query, options.hints), options);
}

/** Async variant used by MemoryEngine when an application supplies a richer interpreter. */
export async function planRetrievalAsync(
  query: string,
  options: QueryPlanningOptions = {},
): Promise<RetrievalDecision> {
  const interpreted = options.interpreter
    ? await options.interpreter.interpret(query)
    : {};
  return planFromProfile(
    profileNaturalLanguageQuery(query, {
      ...(options.hints || {}),
      ...(interpreted || {}),
    }),
    options,
  );
}

/** Read durable graph/native readiness without executing a query or MDX. */
export async function readGraphReadiness(
  ctx: Pick<
    PipelineContextLike,
    "metadataStore" | "config" | "vexusIndex" | "vectorStore"
  >,
): Promise<GraphReadiness> {
  let explicitLinks = 0;
  let activeInferredLinks = 0;
  if (typeof ctx.metadataStore?.listRelations === "function") {
    try {
      const relations = await ctx.metadataStore.listRelations();
      for (const relation of relations) {
        if (relation.origin === "source") explicitLinks += 1;
        else activeInferredLinks += 1;
      }
    } catch (_) {
      // Relation readiness is auxiliary to semantic/vector retrieval. A
      // provider-specific graph read failure must not take down ordinary
      // search; the topology stage will expose its own safe skip if needed.
    }
  }
  const explicitIndex = ctx.vexusIndex as Record<string, unknown> | undefined;
  const vectorIndices = (ctx.vectorStore as { indices?: unknown } | null | undefined)
    ?.indices;
  const ownedIndex =
    explicitIndex ||
    (vectorIndices instanceof Map
      ? (vectorIndices.get(String(ctx.config.tagIndexName || "global_tags")) as
          Record<string, unknown> | undefined)
      : undefined);
  const dbPath = typeof ctx.config.dbPath === "string" ? ctx.config.dbPath : "";
  const topologyArtifactReady =
    !ownedIndex ||
    (typeof ownedIndex.rebuildMemoArtifact === "function" &&
      dbPath.length > 0 &&
      dbPath !== ":memory:" &&
      !dbPath.startsWith("file::memory:"));
  return {
    explicitLinks,
    activeInferredLinks,
    candidatePathCount: explicitLinks + activeInferredLinks > 0 ? 1 : 0,
    topologyArtifactReady,
    permissionScopeReady: true,
  };
}
