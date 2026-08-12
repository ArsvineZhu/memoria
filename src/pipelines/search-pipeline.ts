"use strict";

import Pipeline from "../core/pipeline.js";
import Stage from "../core/stage.js";
import type { MemoryConfigOverrides, SearchOptions } from "../types/config.js";
import type { PipelineContextLike, PipelineData } from "../types/pipeline.js";
import {
  freezeRetrievalPlan,
  normalizeRetrievalPlan,
  assertValidRetrievalPlanInput,
  type RetrievalPlan,
  type RetrievalPlanInput,
} from "../retrieval/retrieval-plan.js";
import type { RetrievalExplanation } from "../retrieval/query-planner.js";
import {
  DEFAULT_SEARCH_GATES,
  buildDefaultSearchStages,
} from "./search-pipeline-stages.js";
import SearchPlanResolver from "./search-plan-resolver.js";
import {
  mergeRunOptions,
  prepareSearchRun,
} from "./search-run-preparation.js";
import { withRetrievalTrace } from "./search-pipeline-trace.js";

export interface SearchPipelineOptions {
  stages?: Stage[];
  defaultRetrievalPlan?: RetrievalPlanInput;
}

/**
 * SearchPipeline — stable facade for plan resolution and hybrid stage
 * execution. Planning, run-context assembly, and trace projection are kept in
 * focused modules so stage orchestration remains easy to inspect.
 */
class SearchPipeline extends Pipeline {
  config: MemoryConfigOverrides;
  readonly defaultRetrievalPlan: RetrievalPlan;
  private readonly customStages: boolean;
  private readonly planResolver: SearchPlanResolver;

  constructor(config: MemoryConfigOverrides = {}, options: SearchPipelineOptions = {}) {
    const effectiveConfig = { ...DEFAULT_SEARCH_GATES, ...config };
    const stages = Array.isArray(options.stages)
      ? options.stages
      : SearchPipeline.defaultStages(effectiveConfig);
    super(stages);
    this.name = "searchPipeline";
    this.customStages = Array.isArray(options.stages);
    assertValidRetrievalPlanInput(options.defaultRetrievalPlan);
    this.defaultRetrievalPlan = freezeRetrievalPlan(
      normalizeRetrievalPlan(options.defaultRetrievalPlan),
    );
    this.config = effectiveConfig;
    this.planResolver = new SearchPlanResolver({
      defaultRetrievalPlan: this.defaultRetrievalPlan,
      hasConfiguredDefaultPlan: options.defaultRetrievalPlan !== undefined,
    });
  }

  /** Build the default search chain honoring the effective config gates. */
  static defaultStages(config: MemoryConfigOverrides): Stage[] {
    return buildDefaultSearchStages(config);
  }

  async explain(
    query: string,
    options: SearchOptions = {},
    ctx: Partial<PipelineContextLike> = {},
  ): Promise<RetrievalExplanation> {
    return this.planResolver.resolve(
      String(query ?? ""),
      options,
      ctx,
      this.config,
    );
  }

  override async run(
    input: PipelineData,
    ctx: Partial<PipelineContextLike> = {},
  ): Promise<PipelineData> {
    const source = input || {};
    const options = (source.options || {}) as SearchOptions;
    const query = typeof source.query === "string" ? source.query : "";
    const resolution = await this.planResolver.resolve(
      query,
      mergeRunOptions(source, options),
      ctx,
      this.config,
    );
    const runConfig = this.planResolver.resolveRunConfig(
      resolution,
      this.config,
      ctx.config,
    );
    const prepared = await prepareSearchRun({
      source,
      options,
      ctx,
      runConfig,
      resolution,
      defaultRetrievalPlan: this.defaultRetrievalPlan,
    });
    const activePipeline = this.customStages
      ? this
      : new Pipeline(SearchPipeline.defaultStages(runConfig));
    const output = (
      this.customStages
        ? await super.run(prepared.payload, prepared.context)
        : await activePipeline.run(prepared.payload, prepared.context)
    ) as PipelineData;
    return withRetrievalTrace(output, activePipeline, resolution);
  }
}

export default SearchPipeline;
