"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import Stage from "../../src/core/stage.js";
import SearchPipeline from "../../src/pipelines/search-pipeline.js";
import type { PipelineContextLike, PipelineData } from "../../src/types.js";
import type { RetrievalDiagnostics } from "../../src/types/documents.js";
import type { QueryProfile } from "../../src/retrieval/query-planner.js";
import type { RetrievalPlan } from "../../src/retrieval/retrieval-plan.js";
import { applyRetrievalPlan } from "../../src/retrieval/retrieval-plan.js";

interface PlannedOutput extends PipelineData {
  retrievalPlan?: RetrievalPlan;
  queryProfile?: QueryProfile;
  captured?: {
    strategy?: string;
    tagBasisProjectionEnabled?: boolean;
    tagResidualDecompositionEnabled?: boolean;
    tagGraphPropagationEnabled?: boolean;
    propagationSupportRerankEnabled?: boolean;
    propagationStructureRerankEnabled?: boolean;
    propagationHistoryEnabled?: boolean;
    tagExpansionEnabled?: boolean;
    embeddingRerankEnabled?: boolean;
    nativeTagRetrievalEnabled?: boolean;
    relationExpansionEnabled?: boolean;
    associatorEnabled?: boolean;
    truncateEnabled?: boolean;
    truncateMinScore?: number;
    timeDecayEnabled?: boolean;
    indexNames?: unknown;
  };
  retrieval?: RetrievalDiagnostics;
}

class CaptureRetrievalPlanStage extends Stage {
  constructor() {
    super();
    this.name = "captureRetrievalPlan";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<PipelineData> {
    const retrievalPlan = ctx.config.retrievalPlan as RetrievalPlan | undefined;
    return {
      ...input,
      captured: {
        strategy: retrievalPlan?.strategy,
        tagBasisProjectionEnabled: ctx.config.tagBasisProjectionEnabled,
        tagResidualDecompositionEnabled: ctx.config.tagResidualDecompositionEnabled,
        tagGraphPropagationEnabled: ctx.config.tagGraphPropagationEnabled,
        propagationSupportRerankEnabled: ctx.config.propagationSupportRerankEnabled,
        propagationStructureRerankEnabled: ctx.config.propagationStructureRerankEnabled,
        propagationHistoryEnabled: ctx.config.propagationHistoryEnabled,
        tagExpansionEnabled: ctx.config.tagExpansionEnabled,
        embeddingRerankEnabled: ctx.config.embeddingRerankEnabled,
        nativeTagRetrievalEnabled: ctx.config.nativeTagRetrievalEnabled,
        relationExpansionEnabled: ctx.config.relationExpansionEnabled,
        associatorEnabled: ctx.config.associatorEnabled,
        truncateEnabled: ctx.config.truncateEnabled,
        truncateMinScore: ctx.config.truncateMinScore,
        timeDecayEnabled: ctx.config.timeDecayEnabled,
        indexNames: ctx.config.indexNames,
      },
    };
  }
}

class TraceStage extends Stage {
  constructor() {
    super();
    this.name = "traceStage";
  }

  override async process(input: PipelineData): Promise<PipelineData> {
    return {
      ...input,
      tagRetrievalSkipped: true,
      tagRetrievalSkipReason: "test fallback",
    };
  }
}

test("SearchPipeline applies automatic structural plan before stages", async () => {
  const pipeline = new SearchPipeline(
    {},
    { stages: [new CaptureRetrievalPlanStage()] },
  );
  const out = await pipeline.run(
    { query: "这份记忆和上次实验有什么关联，沿着路径展开" },
    { config: {} },
  );

  const planned = out as PlannedOutput;
  assert.equal(planned.retrievalPlan?.strategy, "structural");
  assert.equal(planned.queryProfile?.signals?.relational, true);
  assert.equal(planned.captured?.strategy, "structural");
  assert.equal(planned.captured?.propagationStructureRerankEnabled, true);
  assert.equal(planned.captured?.relationExpansionEnabled, true);
});

test("SearchPipeline honors an explicit semantic plan and preserves empty scope", async () => {
  const pipeline = new SearchPipeline(
    {},
    { stages: [new CaptureRetrievalPlanStage()] },
  );
  const out = await pipeline.run(
    {
      query: "这份记忆和上次实验有什么关联？",
      options: {
        retrievalPlan: {
          strategy: "semantic",
          filters: { spaces: [] },
          postprocess: { timeDecay: true, truncate: true, maxResults: 3 },
        },
      },
    },
    { config: {} },
  );

  const planned = out as PlannedOutput;
  assert.equal(planned.retrievalPlan?.strategy, "semantic");
  assert.deepEqual(planned.retrievalPlan?.filters?.spaces, []);
  assert.equal(planned.captured?.strategy, "semantic");
  assert.equal(planned.captured?.propagationStructureRerankEnabled, false);
  assert.equal(planned.captured?.timeDecayEnabled, true);
  assert.deepEqual(planned.captured?.indexNames, []);
});

test("relation expansion is independent from the selected retrieval strategy", async () => {
  const pipeline = new SearchPipeline(
    {},
    { stages: [new CaptureRetrievalPlanStage()] },
  );
  const out = await pipeline.run(
    {
      query: "只按主题找这份记忆",
      options: {
        retrievalPlan: {
          strategy: "associative",
          expansion: { related: true, maxHops: 2, maxAdded: 12 },
        },
      },
    },
    { config: {} },
  );

  const planned = out as PlannedOutput;
  assert.equal(planned.retrievalPlan?.strategy, "associative");
  assert.equal(planned.captured?.relationExpansionEnabled, true);
});

test("automatic strategy keeps typed outer expansion and truncation controls", async () => {
  const pipeline = new SearchPipeline(
    {},
    { stages: [new CaptureRetrievalPlanStage()] },
  );
  const out = await pipeline.run(
    {
      query: "找和实验主题相关的记忆",
      options: {
        retrievalPlan: {
          strategy: "auto",
          expansion: { associate: true },
          postprocess: { truncate: true, minScore: 0.4, maxResults: 3 },
        },
      },
    },
    {
      config: { associatorEnabled: false, truncateEnabled: false, truncateMinScore: 0 },
    },
  );

  const planned = out as PlannedOutput;
  assert.equal(planned.captured?.strategy, "associative");
  assert.equal(planned.captured?.associatorEnabled, true);
  assert.equal(planned.captured?.truncateEnabled, true);
  assert.equal(planned.captured?.truncateMinScore, 0.4);
});

test("native tag retrieval uses one runtime stage per search", () => {
  const stages = SearchPipeline.defaultStages(
    applyRetrievalPlan({ strategy: "structural" }),
  );
  assert.equal(stages.filter((stage) => stage.name === "nativeTagRetrieval").length, 1);
});

test("SearchPipeline exposes stable strategy diagnostics without raw stage names", async () => {
  const pipeline = new SearchPipeline({}, { stages: [new TraceStage()] });
  const out = (await pipeline.run(
    { query: "普通查询" },
    { config: {} },
  )) as PlannedOutput;

  assert.equal(out.retrieval?.strategy, "semantic");
  assert.deepEqual(out.retrieval?.fallbacks, ["disabled-by-plan"]);
  assert.equal("retrievalTrace" in out, false);
});

test("SearchPipeline preserves explicit config gates when no typed default plan is configured", async () => {
  const pipeline = new SearchPipeline(
    { propagationStructureRerankEnabled: true },
    { stages: [new CaptureRetrievalPlanStage()] },
  );
  const out = (await pipeline.run(
    { query: "普通查询" },
    { config: {} },
  )) as PlannedOutput;

  assert.equal(out.retrieval?.plan.strategy, "semantic");
  assert.equal(out.retrieval?.strategySource, "auto");
  assert.equal(out.captured?.propagationStructureRerankEnabled, true);
});

test("SearchPipeline applies a fixed default plan and traces its source", async () => {
  const pipeline = new SearchPipeline(
    {},
    {
      stages: [new CaptureRetrievalPlanStage()],
      defaultRetrievalPlan: {
        strategy: "associative",
        associative: { enabled: true, propagationSupport: true },
        postprocess: { timeDecay: true },
      },
    },
  );
  const out = (await pipeline.run(
    { query: "普通查询" },
    { config: {} },
  )) as PlannedOutput;

  assert.equal(out.retrievalPlan?.strategy, "associative");
  assert.equal(out.retrievalPlan?.associative?.propagationSupport, true);
  assert.equal(out.captured?.strategy, "associative");
  assert.equal(out.captured?.timeDecayEnabled, true);
  assert.equal(out.retrieval?.strategySource, "engine-default");
});

test("SearchPipeline lets one query replace the core default and inherit outer defaults", async () => {
  const pipeline = new SearchPipeline(
    {},
    {
      stages: [new CaptureRetrievalPlanStage()],
      defaultRetrievalPlan: {
        strategy: "associative",
        associative: { enabled: true },
        expansion: { related: true },
        postprocess: { timeDecay: true, dedupe: true },
      },
    },
  );
  const out = (await pipeline.run(
    {
      query: "这份记录的来源",
      options: {
        retrievalPlan: {
          strategy: "structural",
          structural: { enabled: true, propagationStructure: true },
          postprocess: { timeDecay: false },
        },
      },
    },
    { config: {} },
  )) as PlannedOutput;

  assert.equal(out.retrievalPlan?.strategy, "structural");
  assert.equal(out.retrievalPlan?.associative?.enabled, true);
  assert.equal(out.retrievalPlan?.expansion?.related, true);
  assert.equal(out.retrievalPlan?.postprocess?.timeDecay, false);
  assert.equal(out.captured?.strategy, "structural");
  assert.equal(out.captured?.relationExpansionEnabled, true);
  assert.equal(out.captured?.timeDecayEnabled, false);
  assert.equal(out.retrieval?.strategySource, "query-override");
});

test("SearchPipeline can isolate a query from the default plan", async () => {
  const pipeline = new SearchPipeline(
    {},
    {
      stages: [new CaptureRetrievalPlanStage()],
      defaultRetrievalPlan: {
        strategy: "associative",
        associative: { enabled: true },
        postprocess: { timeDecay: true },
      },
    },
  );
  const out = (await pipeline.run(
    {
      query: "普通语义查询",
      options: {
        inheritRetrievalDefaults: false,
        retrievalPlan: { strategy: "semantic" },
      },
    },
    { config: {} },
  )) as PlannedOutput;

  assert.equal(out.retrievalPlan?.strategy, "semantic");
  assert.equal(out.retrievalPlan?.associative?.enabled, false);
  assert.equal(out.retrievalPlan?.postprocess?.timeDecay, false);
  assert.equal(out.retrieval?.strategySource, "query-override");
});

test("isolated queries report auto when no replacement strategy is supplied", async () => {
  const pipeline = new SearchPipeline(
    {},
    {
      stages: [new CaptureRetrievalPlanStage()],
      defaultRetrievalPlan: { strategy: "associative", associative: { enabled: true } },
    },
  );
  const out = (await pipeline.run(
    { query: "普通查询", options: { inheritRetrievalDefaults: false } },
    { config: {} },
  )) as PlannedOutput;

  assert.equal(out.retrieval?.strategySource, "auto");
});
