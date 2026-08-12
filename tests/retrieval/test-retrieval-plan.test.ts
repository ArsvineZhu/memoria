"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyRetrievalPlan,
  mergeRetrievalPlan,
  normalizeRetrievalPlan,
  type RetrievalPlan,
  type RetrievalPlanInput,
} from "../../src/retrieval/retrieval-plan.js";
import * as publicApi from "../../src/index.js";

test("retrieval planning helpers remain internal to the root package", () => {
  assert.equal("normalizeRetrievalPlan" in publicApi, false);
  assert.equal("applyRetrievalPlan" in publicApi, false);
  assert.equal("mergeRetrievalPlan" in publicApi, false);
});

test("normalizeRetrievalPlan uses only canonical strategies and sections", () => {
  const plan = normalizeRetrievalPlan();

  assert.equal(plan.strategy, "auto");
  assert.deepEqual(Object.keys(plan).sort(), [
    "associative",
    "expansion",
    "externalRerank",
    "filters",
    "postprocess",
    "propagationHistory",
    "strategy",
    "structural",
  ]);
  assert.equal(plan.associative?.enabled, false);
  assert.equal(plan.structural?.enabled, false);
  assert.equal(plan.propagationHistory?.enabled, false);
});

test("associative planning enables the canonical tag retrieval chain", () => {
  const plan = normalizeRetrievalPlan({
    strategy: "associative",
    associative: {
      tagBasisProjection: true,
      tagResidualDecomposition: true,
      tagGraphPropagation: true,
      propagationSupport: true,
    },
    externalRerank: { enabled: true, mode: "rrf", alpha: 0.7 },
  });

  assert.equal(plan.strategy, "associative");
  assert.equal(plan.associative?.enabled, true);
  assert.equal(plan.associative?.tagBasisProjection, true);
  assert.equal(plan.associative?.tagResidualDecomposition, true);
  assert.equal(plan.associative?.tagGraphPropagation, true);
  assert.equal(plan.associative?.propagationSupport, true);
  assert.equal(plan.externalRerank?.mode, "rrf");
  assert.equal(plan.externalRerank?.alpha, 0.7);
});

test("structural planning is associative plus independent history and relation controls", () => {
  const config = applyRetrievalPlan({
    strategy: "structural",
    associative: { enabled: true },
    structural: { enabled: true, propagationStructure: true, relationExpansion: true },
    propagationHistory: { enabled: true },
    expansion: { related: true, maxHops: 2, maxAdded: 24 },
    postprocess: { dedupe: true, truncate: true, maxResults: 8 },
  });

  assert.equal(config.tagBasisProjectionEnabled, true);
  assert.equal(config.tagResidualDecompositionEnabled, true);
  assert.equal(config.tagGraphPropagationEnabled, true);
  assert.equal(config.propagationSupportRerankEnabled, true);
  assert.equal(config.propagationStructureRerankEnabled, true);
  assert.equal(config.propagationHistoryEnabled, true);
  assert.equal(config.relationExpansionEnabled, true);
  assert.equal(config.truncateEnabled, true);
  assert.equal(config.maxResults, 8);
});

test("normalizeRetrievalPlan preserves empty scopes and clamps bounded values", () => {
  const input: RetrievalPlan = {
    strategy: "structural",
    filters: { spaces: [] },
    expansion: { related: true, maxHops: -3, maxAdded: 99999 },
    postprocess: { maxResults: 0, maxContentLength: -10 },
  };

  const plan = normalizeRetrievalPlan(input);

  assert.deepEqual(plan.filters?.spaces, []);
  assert.equal(plan.expansion?.maxHops, 0);
  assert.equal(plan.expansion?.maxAdded, 1000);
  assert.equal(plan.postprocess?.maxResults, 1);
  assert.equal(plan.postprocess?.maxContentLength, 0);
});

test("normalizeRetrievalPlan rejects removed strategies and sections", () => {
  assert.throws(
    () =>
      normalizeRetrievalPlan({
        strategy: ["tag", "Graph"].join(""),
      } as unknown as RetrievalPlan),
    /Unknown retrieval strategy/,
  );
  assert.throws(
    () => normalizeRetrievalPlan({ strategy: "semantic", field: {} } as never),
    /unknown field/,
  );
});

test("plan-input validation rejects invalid runtime parameters", () => {
  assert.throws(
    () =>
      mergeRetrievalPlan(normalizeRetrievalPlan({ strategy: "auto" }), {
        externalRerank: { mode: "rrf", alpha: 1.5 },
      }),
    /externalRerank\.alpha/,
  );
});

test("mergeRetrievalPlan replaces the core section and inherits outer layers", () => {
  const defaultPlan = normalizeRetrievalPlan({
    strategy: "associative",
    associative: { enabled: true, propagationSupport: true },
    expansion: { related: true, maxHops: 2 },
    postprocess: { timeDecay: true, dedupe: true },
  });
  const override: RetrievalPlanInput = {
    strategy: "structural",
    structural: { enabled: true, propagationStructure: true },
    postprocess: { timeDecay: false },
  };

  const merged = normalizeRetrievalPlan(mergeRetrievalPlan(defaultPlan, override));

  assert.equal(merged.strategy, "structural");
  assert.equal(merged.associative?.enabled, true);
  assert.equal(merged.structural?.propagationStructure, true);
  assert.equal(merged.expansion?.related, true);
  assert.equal(merged.postprocess?.timeDecay, false);
  assert.equal(merged.postprocess?.dedupe, true);
});

test("mergeRetrievalPlan can isolate a query and does not mutate inputs", () => {
  const defaultPlan = normalizeRetrievalPlan({
    strategy: "associative",
    associative: { enabled: true },
    filters: { spaces: ["research"], metadata: { status: "active" } },
  });
  const override: RetrievalPlanInput = {
    strategy: "semantic",
    filters: { spaces: [], metadata: { owner: "team" } },
  };

  const merged = normalizeRetrievalPlan(
    mergeRetrievalPlan(defaultPlan, override, false),
  );

  assert.equal(merged.strategy, "semantic");
  assert.equal(merged.associative?.enabled, false);
  assert.deepEqual(merged.filters?.spaces, []);
  assert.deepEqual(merged.filters?.metadata, { owner: "team" });
  assert.deepEqual(defaultPlan.filters?.spaces, ["research"]);
  assert.deepEqual(defaultPlan.filters?.metadata, { status: "active" });
  assert.deepEqual(override.filters?.spaces, []);
});
