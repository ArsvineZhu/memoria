"use strict";

import Pipeline from "../core/pipeline.js";
import Stage from "../core/stage.js";
import { at } from "../utils/numerical.js";

import QueryEmbedderStage from "../stages/retrieval/query-embedder.js";
import SearchScopeResolverStage from "../stages/retrieval/search-scope-resolver.js";
import RetrievalFilterResolverStage from "../stages/retrieval/retrieval-filter.js";
import CandidateFilterStage from "../stages/retrieval/candidate-filter.js";
import VectorSearcherStage from "../stages/retrieval/vector-searcher.js";
import BM25SearcherStage from "../stages/retrieval/bm25-searcher.js";
import CandidateMergerStage from "../stages/retrieval/candidate-merger.js";

import EPAProjectorStage from "../stages/memo/epa-projector.js";
import ResidualPyramidStage from "../stages/memo/residual-pyramid.js";
import TagExpanderStage from "../stages/memo/tag-expander.js";
import VectorReshaperStage from "../stages/memo/vector-reshaper.js";
import GeodesicRerankerStage from "../stages/memo/geodesic-reranker.js";
import TagMemoV9Stage from "../stages/memo/tagmemo-v9.js";
import TagMemoV10Stage from "../stages/memo/tagmemo-v10.js";
import RiverMemoStage from "../stages/memo/rivermemo.js";
import NativeMemoRuntimeStage from "../stages/memo/native-memo-runtime.js";
import TopologyV3Stage from "../stages/memo/topology-v3.js";

import ResultDeduplicatorStage from "../stages/postprocess/result-deduplicator.js";
import ExternalRerankerStage from "../stages/postprocess/external-reranker.js";
import TimeDecayStage from "../stages/postprocess/time-decay.js";
import TruncatorStage from "../stages/postprocess/truncator.js";
import ExpanderStage from "../stages/postprocess/expander.js";
import AssociatorStage from "../stages/postprocess/associator.js";
import RelationExpansionStage from "../stages/postprocess/relation-expansion.js";

import ResultFormatterStage from "../stages/output/result-formatter.js";
import type {
  MemoryConfigOverrides,
  PipelineContextLike,
  PipelineData,
  SearchOptions,
} from "../types.js";
import {
  applyRetrievalPlan,
  assertValidRetrievalPlanInput,
  freezeRetrievalPlan,
  mergeRetrievalPlan,
  normalizeRetrievalPlan,
  type RetrievalPlan,
  type RetrievalPlanInput,
} from "../retrieval/retrieval-plan.js";
import {
  planRetrievalAsync,
  readGraphReadiness,
  type RetrievalExplanation,
} from "../retrieval/query-planner.js";

export interface SearchPipelineOptions {
  stages?: Stage[];
  defaultRetrievalPlan?: RetrievalPlanInput;
}

/**
 * Default gate values for the search chain.
 *
 * Phase 4.5 decisions: the memo signal stages that mirror the tag-boosted
 * search path (EPA projection + residual pyramid) are ON by default;
 * every expansion / rerank / tagmemo engine stage is opt-in.
 */
const DEFAULT_SEARCH_GATES = {
  epaProjectionEnabled: true,
  residualPyramidEnabled: true,
  dedupeEnabled: true,
  geodesicRerankEnabled: false,
  associatorEnabled: false,
};

/**
 * QueryVectorBridgeStage — internal adapter between the retrieval and
 * memo layers.
 *
 * QueryEmbedderStage emits `queries: [{ text, vector }]`; every memo /
 * postprocess stage (EPAProjector, ResidualPyramid, VectorReshaper,
 * TagExpander, ResultDeduplicator) consumes a single `queryVector`.
 * This bridge publishes the primary query vector so the memo chain
 * does not need to recompute it.
 *
 * @private
 */
class QueryVectorBridgeStage extends Stage {
  constructor() {
    super();
    this.name = "queryVectorBridge";
  }

  override async process(
    input: PipelineData,
    _ctx: PipelineContextLike,
  ): Promise<PipelineData> {
    const info = input || {};
    const queries = Array.isArray(info.queries) ? info.queries : [];
    const primaryVector =
      info.queryVector ||
      (queries.length > 0 ? at(queries, 0, "queries").vector : undefined);
    if (primaryVector == null) return info;
    return { ...info, queryVector: primaryVector };
  }
}

/**
 * Merge two config objects without letting explicit `undefined` keys from
 * the run-time context clobber the pipeline defaults.
 * @param {object} base
 * @param {object} extra
 * @returns {object}
 */
function mergeConfig(
  base: MemoryConfigOverrides,
  extra: MemoryConfigOverrides = {},
): MemoryConfigOverrides {
  const result = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * Automatic planning is additive for legacy callers. A pre-existing config
 * gate that was deliberately enabled must not be switched off merely because
 * the current natural-language query has no cue for that stage. Explicit
 * retrievalPlan input remains authoritative and can disable every gate.
 */
function mergeAutomaticPlan(
  base: MemoryConfigOverrides,
  planned: MemoryConfigOverrides,
  requestedPlan?: RetrievalPlanInput | null,
): MemoryConfigOverrides {
  const result = mergeConfig(base, planned);
  const autoPlan =
    requestedPlan && requestedPlan.strategy === "auto" ? requestedPlan : null;
  const overrides = new Set<string>();
  const hasOwn = (value: unknown, key: string): boolean =>
    value !== null &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, key);

  if (autoPlan?.postprocess) {
    if (hasOwn(autoPlan.postprocess, "dedupe")) overrides.add("dedupeEnabled");
    if (hasOwn(autoPlan.postprocess, "truncate")) overrides.add("truncateEnabled");
    if (hasOwn(autoPlan.postprocess, "minScore")) overrides.add("truncateMinScore");
    if (hasOwn(autoPlan.postprocess, "maxResults")) {
      overrides.add("topK");
      overrides.add("maxResults");
    }
    if (hasOwn(autoPlan.postprocess, "maxContentLength")) {
      overrides.add("maxContentLength");
    }
    if (hasOwn(autoPlan.postprocess, "timeDecay")) overrides.add("timeDecayEnabled");
  }
  if (autoPlan?.externalRerank) {
    if (hasOwn(autoPlan.externalRerank, "enabled")) {
      overrides.add("externalRerankEnabled");
      overrides.add("useLLMRerank");
    }
    if (hasOwn(autoPlan.externalRerank, "mode")) overrides.add("externalRerankMode");
    if (hasOwn(autoPlan.externalRerank, "alpha")) overrides.add("externalRerankAlpha");
  }
  if (autoPlan?.expansion) {
    if (hasOwn(autoPlan.expansion, "associate")) overrides.add("associatorEnabled");
    if (
      hasOwn(autoPlan.expansion, "sameDocument") ||
      hasOwn(autoPlan.expansion, "fullDocument")
    )
      overrides.add("expansionEnabled");
    if (hasOwn(autoPlan.expansion, "fullDocument"))
      overrides.add("fullDocumentExpansionEnabled");
    if (hasOwn(autoPlan.expansion, "related"))
      overrides.add("relationExpansionEnabled");
  }
  if (autoPlan?.filters) {
    overrides.add("retrievalFilters");
  }
  const preserveKeys = [
    "topK",
    "maxResults",
    "maxContentLength",
    "dedupeEnabled",
    "externalRerankEnabled",
    "useLLMRerank",
    "externalRerankMode",
    "externalRerankAlpha",
    "truncateEnabled",
    "truncateMinScore",
    "tagExpansionEnabled",
    "vectorReshapeEnabled",
    "associatorEnabled",
    "retrievalFilters",
    "fullDocumentExpansionEnabled",
  ];
  for (const key of preserveKeys) {
    if (base[key] !== undefined && !overrides.has(key)) result[key] = base[key];
  }
  for (const key of [
    "tagMemoV9Enabled",
    "tagMemoV10Enabled",
    "riverMemoEnabled",
    "topologyV3Enabled",
    "expansionEnabled",
    "fullDocumentExpansionEnabled",
    "relationExpansionEnabled",
    "timeDecayEnabled",
    "geodesicRerankEnabled",
    "associatorEnabled",
    "truncateEnabled",
  ]) {
    if (planned[key] === true || base[key] === true) result[key] = true;
  }

  // A legacy caller that enabled RiverMemo without the new versioned gate
  // keeps the old JS implementation. Native Topology V3 is selected by the
  // typed plan or by automatic planning on an otherwise neutral config.
  if (base.riverMemoEnabled === true && base.topologyV3Enabled !== true) {
    result.topologyV3Enabled = false;
  }
  if (base.tagMemoV9Enabled === true && base.tagMemoV10Enabled !== true) {
    result.tagMemoV10Enabled = false;
  }
  return result;
}

/**
 * SearchPipeline — the hybrid query flow.
 *
 * Stage chain (defaults marked with ● are ON by default):
 *
 *   1. queryEmbedder      embed the raw query (+ optional expansion)
 *   2. queryVectorBridge   derive queryVector for the memo layers
 *   3. searchScopeResolver  resolve one authoritative diary scope
 *   4. nativeMemoRuntime    optional Rust Memo observation          [gate]
 *   5. vectorSearcher       per-diary vector retrieval
 *   6. bm25Searcher         sparse keyword retrieval
 *   7. candidateMerger      hybrid fusion (vector + BM25)
 *   8. epaProjector         ● semantic depth analysis of the query
 *   9. residualPyramid      ● tag-subspace decomposition of the query
 *  10. tagMemoV9            wave propagation over tagGraph        [gate]
 *  11. tagMemoV10           dual scaled-field diffusion          [gate]
 *  12. topologyV3           Rust RiverMemo Topology V3            [gate]
 *  13. tagExpander          tag-driven candidate expansion       [gate]
 *  14. vectorReshaper       cosine re-ranking of candidates      [gate]
 *  15. geodesicReranker     tag-energy reranking                 [gate]
 *  16. relationExpansion    explicit/derived relation expansion  [gate]
 *  17. expander             same-file sibling expansion          [gate]
 *  18. associator           tag/vector related chunks            [gate]
 *  19. resultDeduplicator   ● exact + semantic dedupe
 *  20. externalReranker     LLM/external rerank                  [gate]
 *  21. timeDecay            recency decay                        [gate]
 *  22. truncator            topK/content caps                    [gate]
 *  23. candidateFilter      final hard candidate scope            [gate]
 *  24. resultFormatter      hydrated result envelope
 *
 * Gates (config keys): epaProjectionEnabled (default true),
 * residualPyramidEnabled (default true), nativeMemoEnabled,
 * tagMemoV9Enabled, tagMemoV10Enabled, riverMemoEnabled,
 * topologyV3Enabled, tagExpansionEnabled, vectorReshapeEnabled,
 * externalRerankEnabled (alias useLLMRerank), geodesicRerankEnabled,
 * relationExpansionEnabled, timeDecayEnabled, truncateEnabled,
 * expansionEnabled, associatorEnabled.
 * dedupeEnabled is honored inside the stage itself (it lives in the
 * chain regardless so the envelope stays complete).
 *
 * Usage:
 *   const pipeline = new SearchPipeline(config);
 *   const out = await pipeline.run(
 *     { query: '…', options: { diaryNames, topK, … } },
 *     ctx
 *   );
 *
 * Result envelope: { … inputs, queries, vectorResults, bm25Results,
 * mergedCandidates, epa?, pyramid?, tagMemo?, geodesic?, riverMemo?,
 * topologyV3?, associatorStats?, results: [ …hydrated chunks], resultCount }.
 */
class SearchPipeline extends Pipeline {
  config: MemoryConfigOverrides;
  readonly defaultRetrievalPlan: RetrievalPlan;
  private readonly hasConfiguredDefaultPlan: boolean;
  private readonly customStages: boolean;
  /**
   * @param {object} [config={}] - gates + retrieval knobs (topK, weights …).
   *                               Non-explicit values fall back to
   *                               DEFAULT_SEARCH_GATES.
   * @param {object} [options={}]
   * @param {import('../core/stage.js').Stage[]} [options.stages] - explicit chain override
   */
  constructor(config: MemoryConfigOverrides = {}, options: SearchPipelineOptions = {}) {
    const effectiveConfig = { ...DEFAULT_SEARCH_GATES, ...config };
    const stages = Array.isArray(options.stages)
      ? options.stages
      : SearchPipeline.defaultStages(effectiveConfig);
    super(stages);
    this.name = "searchPipeline";
    this.hasConfiguredDefaultPlan = options.defaultRetrievalPlan !== undefined;
    assertValidRetrievalPlanInput(options.defaultRetrievalPlan);
    this.defaultRetrievalPlan = freezeRetrievalPlan(
      normalizeRetrievalPlan(options.defaultRetrievalPlan),
    );
    this.config = effectiveConfig;
    this.customStages = Array.isArray(options.stages);
  }

  /**
   * Build the default search chain honoring the config gates.
   * @param {object} config - effective gate config
   * @returns {import('../core/stage.js').Stage[]}
   */
  static defaultStages(config: MemoryConfigOverrides): Stage[] {
    const stages: Stage[] = [
      new QueryEmbedderStage(),
      new QueryVectorBridgeStage(),
      new SearchScopeResolverStage(),
    ];

    if (config.nativeMemoEnabled === true || config.topologyV3Enabled === true) {
      stages.push(new NativeMemoRuntimeStage());
    }
    stages.push(
      new VectorSearcherStage(),
      new BM25SearcherStage(),
      new CandidateMergerStage(),
    );

    const filters = config.retrievalFilters;
    const hasChunkFilters =
      filters !== null &&
      typeof filters === "object" &&
      (Array.isArray((filters as Record<string, unknown>).spaces) ||
        Array.isArray((filters as Record<string, unknown>).documentIds) ||
        (filters as Record<string, unknown>).recordedAfter !== undefined ||
        (filters as Record<string, unknown>).recordedBefore !== undefined ||
        (filters as Record<string, unknown>).metadata !== undefined);
    if (hasChunkFilters) stages.splice(3, 0, new RetrievalFilterResolverStage());

    if (config.epaProjectionEnabled !== false) stages.push(new EPAProjectorStage());
    if (config.residualPyramidEnabled !== false)
      stages.push(new ResidualPyramidStage());
    if (config.tagMemoV9Enabled === true) stages.push(new TagMemoV9Stage());
    if (config.tagMemoV10Enabled === true) stages.push(new TagMemoV10Stage());
    if (config.topologyV3Enabled === true) {
      stages.push(new TopologyV3Stage());
    } else if (config.riverMemoEnabled === true) {
      // Preserve the legacy JS RiverMemo gate for callers that explicitly
      // selected it without requesting the native Topology V3 contract.
      stages.push(new RiverMemoStage());
    }

    if (config.tagExpansionEnabled === true) stages.push(new TagExpanderStage());
    if (config.vectorReshapeEnabled === true) stages.push(new VectorReshaperStage());
    if (config.geodesicRerankEnabled === true) stages.push(new GeodesicRerankerStage());

    // All candidate-producing expansions run before the common postprocess
    // tail. This keeps dedupe, external rerank, decay, truncation and the
    // final hard scope equally applicable to direct and expanded memories.
    if (config.relationExpansionEnabled === true)
      stages.push(new RelationExpansionStage());

    if (config.expansionEnabled === true) stages.push(new ExpanderStage());
    if (config.associatorEnabled === true) stages.push(new AssociatorStage());

    stages.push(new ResultDeduplicatorStage());

    if (config.externalRerankEnabled === true || config.useLLMRerank === true)
      stages.push(new ExternalRerankerStage());
    if (config.timeDecayEnabled === true) stages.push(new TimeDecayStage());
    if (config.truncateEnabled === true) stages.push(new TruncatorStage());

    if (hasChunkFilters) stages.push(new CandidateFilterStage());

    stages.push(new ResultFormatterStage());
    return stages;
  }

  private async resolvePlan(
    query: string,
    options: SearchOptions = {},
    ctx: Partial<PipelineContextLike> = {},
  ): Promise<RetrievalExplanation> {
    const rawPlan = options.retrievalPlan;
    assertValidRetrievalPlanInput(rawPlan);
    const queryPlanOverride = rawPlan == null ? undefined : rawPlan;
    const inheritRetrievalDefaults = options.inheritRetrievalDefaults !== false;
    const hasQueryPlanOverride =
      queryPlanOverride !== undefined || options.inheritRetrievalDefaults === false;
    const planInput =
      hasQueryPlanOverride || this.hasConfiguredDefaultPlan
        ? mergeRetrievalPlan(
            this.defaultRetrievalPlan,
            queryPlanOverride,
            inheritRetrievalDefaults,
          )
        : undefined;
    const baseConfig = mergeConfig(this.config, ctx && ctx.config);
    const planningContext: PipelineContextLike = {
      ...ctx,
      config: baseConfig,
    };
    const decision = await planRetrievalAsync(query, {
      plan: planInput,
      interpreter: ctx.queryInterpreter,
      readiness: await readGraphReadiness(planningContext),
    });
    const strategySource: RetrievalExplanation["strategySource"] =
      hasQueryPlanOverride &&
      queryPlanOverride !== undefined &&
      Object.prototype.hasOwnProperty.call(queryPlanOverride, "strategy")
        ? "query-override"
        : inheritRetrievalDefaults &&
            this.hasConfiguredDefaultPlan &&
            this.defaultRetrievalPlan.strategy !== "auto"
          ? "engine-default"
          : "auto";

    return {
      ...decision,
      defaultPlan: this.defaultRetrievalPlan,
      requestedPlan: queryPlanOverride,
      strategySource,
      defaultsInherited: inheritRetrievalDefaults,
      queryOverrideApplied: hasQueryPlanOverride,
    };
  }

  /** Explain plan/default resolution without running retrieval stages. */
  async explain(
    query: string,
    options: SearchOptions = {},
    ctx: Partial<PipelineContextLike> = {},
  ): Promise<RetrievalExplanation> {
    return this.resolvePlan(String(query ?? ""), options, ctx);
  }

  /**
   * Search entry point.
   *
   * The pipeline gates are merged underneath the caller-supplied context
   * config, so explicit per-run flags always win while unset keys keep
   * the phase-4.5 defaults. `input.options` is flattened into the payload
   * (diaryNames, topK, …) so downstream stages pick it up as-is.
   *
   * @param {{ query: string, options?: object }} input
   * @param {import('../core/context.js').PipelineContext} ctx
   * @returns {Promise<object>} result envelope
   */
  override async run(
    input: PipelineData,
    ctx: Partial<PipelineContextLike> = {},
  ): Promise<PipelineData> {
    const source = input || {};
    const options = (source.options || {}) as SearchOptions;
    const query = typeof source.query === "string" ? source.query : "";
    const planResolution = await this.resolvePlan(
      query,
      {
        ...options,
        retrievalPlan: options.retrievalPlan ?? source.retrievalPlan,
      },
      ctx,
    );
    const queryPlanOverride = planResolution.requestedPlan;
    const hasQueryPlanOverride = planResolution.queryOverrideApplied;
    const inheritRetrievalDefaults = planResolution.defaultsInherited;
    const decision = planResolution;
    const baseConfig = mergeConfig(this.config, ctx && ctx.config);
    const plannedConfig = applyRetrievalPlan(decision.plan);
    const runConfig = decision.explicit
      ? mergeConfig(baseConfig, plannedConfig)
      : mergeAutomaticPlan(
          baseConfig,
          plannedConfig,
          hasQueryPlanOverride
            ? queryPlanOverride || undefined
            : this.hasConfiguredDefaultPlan
              ? this.defaultRetrievalPlan
              : undefined,
        );
    const strategySource = decision.strategySource;
    let tagGraph = ctx.tagGraph;
    let tagGraphLoadError: string | undefined;
    if (
      !(tagGraph instanceof Map) &&
      (runConfig.tagMemoV9Enabled === true || runConfig.tagMemoV10Enabled === true) &&
      typeof ctx.metadataStore?.buildCooccurrenceMatrix === "function"
    ) {
      try {
        tagGraph = await ctx.metadataStore.buildCooccurrenceMatrix();
      } catch (error) {
        tagGraph = new Map();
        tagGraphLoadError = error instanceof Error ? error.message : String(error);
      }
    }
    const riverStateStore =
      ctx.riverStateStore ||
      (typeof ctx.metadataStore?.getKv === "function" &&
      typeof ctx.metadataStore?.setKv === "function"
        ? {
            getKv: ctx.metadataStore.getKv.bind(ctx.metadataStore),
            setKv: ctx.metadataStore.setKv.bind(ctx.metadataStore),
          }
        : undefined);
    const runCtx: PipelineContextLike = {
      ...ctx,
      config: runConfig as import("../types.js").MemoryConfig,
      tagGraph,
      riverStateStore,
    };

    const payload = { ...source };
    Object.assign(payload, options, {
      query: source.query,
      retrievalPlan: decision.plan,
      defaultRetrievalPlan: this.defaultRetrievalPlan,
      requestedRetrievalPlan: queryPlanOverride || undefined,
      queryProfile: decision.profile,
      retrievalDecision: {
        strategy: decision.decision.strategy,
        scores: decision.decision.scores,
        reasons: decision.decision.reasons,
        fallback: decision.decision.fallback,
        reason: decision.reason,
        confidence: decision.confidence,
        explicit: decision.explicit,
        strategySource,
        defaultsInherited: decision.defaultsInherited,
        queryOverrideApplied: decision.queryOverrideApplied,
      },
    });
    if (tagGraphLoadError) payload.tagMemoGraphLoadError = tagGraphLoadError;

    const activePipeline = this.customStages
      ? this
      : new Pipeline(SearchPipeline.defaultStages(runConfig));
    const output = (
      this.customStages
        ? await super.run(payload, runCtx)
        : await activePipeline.run(payload, runCtx)
    ) as PipelineData;
    const fallbacks: string[] = [];
    for (const [key, value] of Object.entries(output)) {
      if (!key.endsWith("Skipped") || value !== true) continue;
      const reasonKey = `${key.slice(0, -"Skipped".length)}SkipReason`;
      const reason = output[reasonKey];
      fallbacks.push(
        `${key.slice(0, -"Skipped".length)}: ${String(reason || "skipped")}`,
      );
    }
    return {
      ...output,
      retrievalTrace: {
        defaultPlan: this.defaultRetrievalPlan,
        requestedPlan: queryPlanOverride || undefined,
        plan: decision.plan,
        profile: decision.profile,
        decision: decision.decision,
        strategySource,
        defaultsInherited: decision.defaultsInherited,
        queryOverrideApplied: decision.queryOverrideApplied,
        stageOrder: activePipeline.stages.map((stage) => stage.name || "anonymous"),
        fallbacks,
      },
    };
  }
}

export default SearchPipeline;
