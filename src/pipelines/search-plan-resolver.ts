import type { MemoryConfigOverrides, SearchOptions } from "../types/config.js";
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

/** Merge configs without allowing explicit undefined values to erase defaults. */
export function mergeSearchConfig(
  base: MemoryConfigOverrides,
  extra: MemoryConfigOverrides = {},
): MemoryConfigOverrides {
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
  base: MemoryConfigOverrides,
  planned: MemoryConfigOverrides,
  requestedPlan?: RetrievalPlanInput | null,
): MemoryConfigOverrides {
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

  const preserveKeys = [
    "topK",
    "maxResults",
    "maxContentLength",
    "dedupeEnabled",
    "externalRerankEnabled",
    "externalRerankMode",
    "externalRerankAlpha",
    "truncateEnabled",
    "truncateMinScore",
    "tagExpansionEnabled",
    "embeddingRerankEnabled",
    "associatorEnabled",
    "retrievalFilters",
    "fullDocumentExpansionEnabled",
  ];
  for (const key of preserveKeys) {
    if (base[key as keyof MemoryConfigOverrides] !== undefined && !overrides.has(key)) {
      target[key] = base[key as keyof MemoryConfigOverrides];
    }
  }
  for (const key of [
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
    "truncateEnabled",
  ]) {
    if (
      planned[key as keyof MemoryConfigOverrides] === true ||
      base[key as keyof MemoryConfigOverrides] === true
    ) {
      target[key] = true;
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
    pipelineConfig: MemoryConfigOverrides = {},
  ): Promise<RetrievalExplanation> {
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
    pipelineConfig: MemoryConfigOverrides,
    contextConfig: MemoryConfigOverrides = {},
  ): MemoryConfigOverrides {
    const baseConfig = mergeSearchConfig(pipelineConfig, contextConfig);
    const plannedConfig = applyRetrievalPlan(resolution.plan);
    return resolution.explicit
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
  }
}
