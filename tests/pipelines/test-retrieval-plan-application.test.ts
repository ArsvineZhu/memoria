"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import Stage from "../../src/core/stage.js";
import SearchPipeline from "../../src/pipelines/search-pipeline.js";
import type { PipelineContextLike, PipelineData } from "../../src/types.js";
import type { QueryProfile } from "../../src/retrieval/query-planner.js";
import type { RetrievalPlan } from "../../src/retrieval/retrieval-plan.js";
import { applyRetrievalPlan } from "../../src/retrieval/retrieval-plan.js";

interface PlannedOutput extends PipelineData {
  retrievalPlan?: RetrievalPlan;
  queryProfile?: QueryProfile;
  captured?: {
    strategy?: string;
    riverMemoEnabled?: boolean;
    expansionEnabled?: boolean;
    relationExpansionEnabled?: boolean;
    associatorEnabled?: boolean;
    truncateEnabled?: boolean;
    truncateMinScore?: number;
    timeDecayEnabled?: boolean;
    indexNames?: unknown;
  };
  retrievalTrace?: {
    stageOrder: string[];
    fallbacks: string[];
    decision: { strategy: string };
    plan: { strategy: string };
    strategySource?: string;
    defaultsInherited?: boolean;
    queryOverrideApplied?: boolean;
  };
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
        tagMemoV9Enabled: ctx.config.tagMemoV9Enabled,
        tagMemoV10Enabled: ctx.config.tagMemoV10Enabled,
        riverMemoEnabled: ctx.config.riverMemoEnabled,
        expansionEnabled: ctx.config.expansionEnabled,
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
      nativeMemoSkipped: true,
      nativeMemoSkipReason: "test fallback",
    };
  }
}

test("SearchPipeline applies automatic topology plan before stages", async () => {
  const pipeline = new SearchPipeline(
    {},
    { stages: [new CaptureRetrievalPlanStage()] },
  );
  const out = await pipeline.run(
    { query: "这份记忆和上次实验有什么关联，沿着路径展开" },
    { config: {} },
  );

  const planned = out as PlannedOutput;
  assert.equal(planned.retrievalPlan?.strategy, "topology");
  assert.equal(planned.queryProfile?.signals?.relational, true);
  assert.equal(planned.captured?.strategy, "topology");
  assert.equal(planned.captured?.riverMemoEnabled, true);
  assert.equal(planned.captured?.expansionEnabled, true);
});

test("SearchPipeline honors an explicit plan and preserves empty scope", async () => {
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
  assert.equal(planned.captured?.riverMemoEnabled, false);
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
          strategy: "field",
          expansion: { related: true, maxHops: 2, maxAdded: 12 },
        },
      },
    },
    { config: {} },
  );

  const planned = out as PlannedOutput;
  assert.equal(planned.retrievalPlan?.strategy, "field");
  assert.equal(planned.captured?.expansionEnabled, false);
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
      config: {
        associatorEnabled: false,
        truncateEnabled: false,
        truncateMinScore: 0,
      },
    },
  );

  const planned = out as PlannedOutput;
  assert.equal(planned.captured?.strategy, "field");
  assert.equal(planned.captured?.associatorEnabled, true);
  assert.equal(planned.captured?.truncateEnabled, true);
  assert.equal(planned.captured?.truncateMinScore, 0.4);
});

test("Topology V3 uses one native Memo runtime stage per search", () => {
  const stages = SearchPipeline.defaultStages(
    applyRetrievalPlan({ strategy: "topology" }),
  );
  assert.equal(stages.filter((stage) => stage.name === "nativeMemoRuntime").length, 1);
});

test("SearchPipeline exposes the selected strategy, stage order and fallbacks", async () => {
  const pipeline = new SearchPipeline({}, { stages: [new TraceStage()] });
  const out = (await pipeline.run(
    { query: "普通查询" },
    { config: {} },
  )) as PlannedOutput;

  assert.equal(out.retrievalTrace?.decision.strategy, "semantic");
  assert.deepEqual(out.retrievalTrace?.stageOrder, ["traceStage"]);
  assert.deepEqual(out.retrievalTrace?.fallbacks, ["nativeMemo: test fallback"]);
});

test("SearchPipeline preserves legacy gates when no typed default plan is configured", async () => {
  const pipeline = new SearchPipeline(
    { riverMemoEnabled: true },
    { stages: [new CaptureRetrievalPlanStage()] },
  );
  const out = (await pipeline.run(
    { query: "普通查询" },
    { config: {} },
  )) as PlannedOutput;

  assert.equal(out.retrievalTrace?.plan.strategy, "semantic");
  assert.equal(out.retrievalTrace?.strategySource, "auto");
  assert.equal(out.captured?.riverMemoEnabled, true);
});

test("SearchPipeline applies a fixed default plan and traces its source", async () => {
  const pipeline = new SearchPipeline(
    {},
    {
      stages: [new CaptureRetrievalPlanStage()],
      defaultRetrievalPlan: {
        strategy: "field",
        tagMemo: { plus: true, version: "v10" },
        postprocess: { timeDecay: true },
      },
    },
  );
  const out = (await pipeline.run(
    { query: "普通查询" },
    { config: {} },
  )) as PlannedOutput;

  assert.equal(out.retrievalPlan?.strategy, "field");
  assert.equal(out.retrievalPlan?.tagMemo?.plus, true);
  assert.equal(out.captured?.strategy, "field");
  assert.equal(out.captured?.timeDecayEnabled, true);
  assert.equal(out.retrievalTrace?.strategySource, "engine-default");
  assert.equal(out.retrievalTrace?.defaultsInherited, true);
  assert.equal(out.retrievalTrace?.queryOverrideApplied, false);
});

test("SearchPipeline lets one query replace the core default and inherit outer defaults", async () => {
  const pipeline = new SearchPipeline(
    {},
    {
      stages: [new CaptureRetrievalPlanStage()],
      defaultRetrievalPlan: {
        strategy: "field",
        tagMemo: { plus: true },
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
          strategy: "topology",
          riverMemo: { enabled: true, rerank: true, version: "v3" },
          postprocess: { timeDecay: false },
        },
      },
    },
    { config: {} },
  )) as PlannedOutput;

  assert.equal(out.retrievalPlan?.strategy, "topology");
  assert.equal(out.retrievalPlan?.tagMemo?.enabled, false);
  assert.equal(out.retrievalPlan?.expansion?.related, true);
  assert.equal(out.retrievalPlan?.postprocess?.timeDecay, false);
  assert.equal(out.captured?.strategy, "topology");
  assert.equal(out.captured?.relationExpansionEnabled, true);
  assert.equal(out.captured?.timeDecayEnabled, false);
  assert.equal(out.retrievalTrace?.strategySource, "query-override");
  assert.equal(out.retrievalTrace?.defaultsInherited, true);
  assert.equal(out.retrievalTrace?.queryOverrideApplied, true);
});

test("SearchPipeline can isolate a query from the default plan", async () => {
  const pipeline = new SearchPipeline(
    {},
    {
      stages: [new CaptureRetrievalPlanStage()],
      defaultRetrievalPlan: {
        strategy: "field",
        tagMemo: { plus: true },
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
  assert.equal(out.retrievalPlan?.tagMemo?.enabled, false);
  assert.equal(out.retrievalPlan?.postprocess?.timeDecay, false);
  assert.equal(out.retrievalTrace?.defaultsInherited, false);
  assert.equal(out.retrievalTrace?.strategySource, "query-override");
});

test("isolated queries report auto when no replacement strategy is supplied", async () => {
  const pipeline = new SearchPipeline(
    {},
    {
      stages: [new CaptureRetrievalPlanStage()],
      defaultRetrievalPlan: { strategy: "field", tagMemo: { plus: true } },
    },
  );
  const out = (await pipeline.run(
    {
      query: "普通查询",
      options: { inheritRetrievalDefaults: false },
    },
    { config: {} },
  )) as PlannedOutput;

  assert.equal(out.retrievalTrace?.strategySource, "auto");
  assert.equal(out.retrievalTrace?.defaultsInherited, false);
});
