"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import SearchPipeline from "../../src/pipelines/search-pipeline.js";
import Stage from "../../src/core/stage.js";
import ActivationPropagationStage from "../../src/stages/tag-retrieval/activation-propagation.js";
import GraphDiffusionStage from "../../src/stages/tag-retrieval/graph-diffusion.js";
import type { PipelineContextLike, PipelineData } from "../../src/types/pipeline.js";

class PreparationProbeStage extends Stage {
  constructor() {
    super();
    this.name = "preparationProbe";
  }

  override async process(
    input: PipelineData,
    _ctx: PipelineContextLike,
  ): Promise<PipelineData> {
    return input;
  }
}

test("search preparation does not build the TypeScript cooccurrence graph eagerly", async () => {
  let buildCount = 0;
  const pipeline = new SearchPipeline({}, { stages: [new PreparationProbeStage()] });

  await pipeline.run(
    {
      query: "找实验主题",
      options: { retrievalPlan: { strategy: "associative" } },
    },
    {
      config: { tagGraphPropagationEnabled: true },
      metadataStore: {
        async buildCooccurrenceMatrix() {
          buildCount += 1;
          return new Map();
        },
      } as never,
    },
  );

  assert.equal(buildCount, 0);
});

test("TypeScript fallback loads the cooccurrence graph only when activation runs", async () => {
  let buildCount = 0;
  const pipeline = new SearchPipeline(
    {},
    { stages: [new ActivationPropagationStage()] },
  );

  const output = await pipeline.run(
    {
      query: "找实验主题",
      tagResidualDecomposition: {
        levels: [{ tags: [{ id: 1, contribution: 1 }] }],
      },
      options: { retrievalPlan: { strategy: "associative" } },
    },
    {
      config: { tagGraphPropagationEnabled: true },
      metadataStore: {
        async buildCooccurrenceMatrix() {
          buildCount += 1;
          return new Map([[1, new Map([[2, 1]])]]);
        },
      } as never,
    },
  );

  assert.equal(buildCount, 1);
  assert.ok(output.tagGraphPropagation);
});

test("TypeScript fallback shares the lazy graph with diffusion", async () => {
  let buildCount = 0;
  const pipeline = new SearchPipeline(
    {},
    { stages: [new ActivationPropagationStage(), new GraphDiffusionStage()] },
  );

  const output = await pipeline.run(
    {
      query: "找实验主题",
      tagResidualDecomposition: {
        levels: [{ tags: [{ id: 1, contribution: 1 }] }],
      },
      mergedCandidates: [{ chunkId: 1, score: 0.7, tags: ["1"] }],
      options: { retrievalPlan: { strategy: "associative" } },
    },
    {
      config: { tagGraphPropagationEnabled: true },
      metadataStore: {
        async buildCooccurrenceMatrix() {
          buildCount += 1;
          return new Map([
            [1, new Map([[2, 1]])],
            [2, new Map([[1, 1]])],
          ]);
        },
      } as never,
    },
  );

  assert.equal(buildCount, 1);
  assert.equal(output.graphDiffusionSkipped, undefined);
  assert.equal(output.tagGraphPropagation?.schema, "tag-graph-diffusion-v1");
});
