import type { ResolvedMemoryConfigOverrides, SearchOptions } from "../types/config.js";
import type { PipelineContextLike } from "../types/pipeline.js";
import {
  applyRetrievalPlan,
  assertValidRetrievalPlanInput,
  mergeRetrievalPlan,
  type RetrievalPlan,
  type RetrievalPlanInput,
} from "../retrieval/retrieval-plan.js";
import {
  planRetrievalAsync,
  readGraphReadiness,
  type RetrievalExplanation,
} from "../retrieval/query-planner.js";

export interface SearchPlanResolverOptions {
  defaultRetrievalPlan: RetrievalPlan;
  hasConfiguredDefaultPlan: boolean;
}

const SEARCH_OPTION_KEYS = new Set<keyof SearchOptions>([
  "retrievalPlan",
  "inheritRetrievalDefaults",
  "topK",
  "indexNames",
  "spaces",
  "queryExpansion",
  "queryEpsilon",
]);

function assertKnownSearchOptions(options: SearchOptions): void {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("SearchOptions must be an object");
  }
  for (const key of Object.keys(options)) {
    if (!SEARCH_OPTION_KEYS.has(key as keyof SearchOptions)) {
      throw new TypeError(`Unknown SearchOptions key: ${key}`);
    }
  }
}

/** Merge configs without allowing explicit undefined values to erase defaults. */
export function mergeSearchConfig(
  base: ResolvedMemoryConfigOverrides,
  extra: ResolvedMemoryConfigOverrides = {},
): ResolvedMemoryConfigOverrides {
  const result = { ...base };
  const target = result as Record<string, unknown>;
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) target[key] = value;
  }
  return result;
}

/**
 * Keep automatic planning additive for configured callers. Explicit plan input
 * remains authoritative and can disable every gate.
 */
function mergeAutomaticSearchPlan(
  base: ResolvedMemoryConfigOverrides,
  planned: ResolvedMemoryConfigOverrides,
  requestedPlan?: RetrievalPlanInput | null,
): ResolvedMemoryConfigOverrides {
  const result = mergeSearchConfig(base, planned);
  const target = result as Record<string, unknown>;
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
    }
    if (hasOwn(autoPlan.externalRerank, "mode")) overrides.add("externalRerankMode");
    if (hasOwn(autoPlan.externalRerank, "alpha")) overrides.add("externalRerankAlpha");
  }
  if (autoPlan?.expansion) {
    if (hasOwn(autoPlan.expansion, "associate")) overrides.add("associatorEnabled");
    if (
      hasOwn(autoPlan.expansion, "sameDocument") ||
      hasOwn(autoPlan.expansion, "fullDocument")
    ) {
      overrides.add("expansionEnabled");
    }
    if (hasOwn(autoPlan.expansion, "fullDocument")) {
      overrides.add("fullDocumentExpansionEnabled");
    }
    if (hasOwn(autoPlan.expansion, "related")) {
      overrides.add("relationExpansionEnabled");
    }
  }
  if (autoPlan?.filters) overrides.add("retrievalFilters");

  const preserveKeys = ["topK", "maxResults", "maxContentLength"];
  const planControlledKeys = [
    "tagBasisProjectionEnabled",
    "tagResidualDecompositionEnabled",
    "tagGraphPropagationEnabled",
    "propagationSupportRerankEnabled",
    "propagationStructureRerankEnabled",
    "propagationHistoryEnabled",
    "nativeTagRetrievalEnabled",
    "expansionEnabled",
    "fullDocumentExpansionEnabled",
    "relationExpansionEnabled",
    "timeDecayEnabled",
    "embeddingRerankEnabled",
    "associatorEnabled",
    "tagExpansionEnabled",
    "externalRerankEnabled",
    "externalRerankMode",
    "externalRerankAlpha",
    "dedupeEnabled",
    "truncateEnabled",
    "truncateMinScore",
    "retrievalFilters",
  ];
  for (const key of planControlledKeys) {
    if (Object.prototype.hasOwnProperty.call(planned, key)) {
      target[key] = planned[key as keyof ResolvedMemoryConfigOverrides];
    }
  }
  for (const key of preserveKeys) {
    if (
      base[key as keyof ResolvedMemoryConfigOverrides] !== undefined &&
      !overrides.has(key)
    ) {
      target[key] = base[key as keyof ResolvedMemoryConfigOverrides];
    }
  }
  return result;
}

/** Owns retrieval-plan inheritance, readiness and config projection. */
export default class SearchPlanResolver {
  constructor(private readonly options: SearchPlanResolverOptions) {}

  async resolve(
    query: string,
    options: SearchOptions = {},
    ctx: Partial<PipelineContextLike> = {},
    pipelineConfig: ResolvedMemoryConfigOverrides = {},
  ): Promise<RetrievalExplanation> {
    assertKnownSearchOptions(options);
    const rawPlan = options.retrievalPlan;
    assertValidRetrievalPlanInput(rawPlan);
    const queryPlanOverride = rawPlan == null ? undefined : rawPlan;
    const inheritRetrievalDefaults = options.inheritRetrievalDefaults !== false;
    const hasQueryPlanOverride =
      queryPlanOverride !== undefined || options.inheritRetrievalDefaults === false;
    const planInput =
      hasQueryPlanOverride || this.options.hasConfiguredDefaultPlan
        ? mergeRetrievalPlan(
            this.options.defaultRetrievalPlan,
            queryPlanOverride,
            inheritRetrievalDefaults,
          )
        : undefined;
    const baseConfig = mergeSearchConfig(pipelineConfig, ctx.config);
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
            this.options.hasConfiguredDefaultPlan &&
            this.options.defaultRetrievalPlan.strategy !== "auto"
          ? "engine-default"
          : "auto";

    return {
      ...decision,
      defaultPlan: this.options.defaultRetrievalPlan,
      requestedPlan: queryPlanOverride,
      strategySource,
      defaultsInherited: inheritRetrievalDefaults,
      queryOverrideApplied: hasQueryPlanOverride,
    };
  }

  resolveRunConfig(
    resolution: RetrievalExplanation,
    pipelineConfig: ResolvedMemoryConfigOverrides,
    contextConfig: ResolvedMemoryConfigOverrides = {},
    options: SearchOptions = {},
  ): ResolvedMemoryConfigOverrides {
    const baseConfig = mergeSearchConfig(pipelineConfig, contextConfig);
    const plannedConfig = applyRetrievalPlan(resolution.plan);
    const runConfig = resolution.explicit
      ? mergeSearchConfig(baseConfig, plannedConfig)
      : mergeAutomaticSearchPlan(
          baseConfig,
          plannedConfig,
          resolution.queryOverrideApplied
            ? resolution.requestedPlan || undefined
            : this.options.hasConfiguredDefaultPlan
              ? this.options.defaultRetrievalPlan
              : undefined,
        );
    if (options.queryExpansion !== undefined) {
      runConfig.queryExpansion = options.queryExpansion;
    }
    if (Object.prototype.hasOwnProperty.call(options, "queryEpsilon")) {
      runConfig.queryEpsilon = options.queryEpsilon;
    }
    return runConfig;
  }
}
