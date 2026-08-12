"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { TagResidualDecomposition } from "../../src/algorithms/tag-residual-decomposition.js";
import type { VectorHit, VectorLike } from "../../src/types.js";
import { at } from "../../src/utils/numerical.js";

test("TagResidualDecomposition.analyze returns empty result for zero-energy vector", async () => {
  const rp = new TagResidualDecomposition({ dimension: 4 });
  const zeroVec = new Float32Array([0, 0, 0, 0]);
  const result = await rp.analyze(zeroVec, {
    searchFn: async () => [],
    lookupFn: async () => [],
  });
  assert.strictEqual(result.levels.length, 0);
  assert.strictEqual(result.features.depth, 0);
});

test("TagResidualDecomposition.analyze decomposes vector into residual levels", async () => {
  const dim = 4;
  const tagDb = [
    { id: 1, name: "tag-a", vector: new Float32Array([1, 0, 0, 0]) },
    { id: 2, name: "tag-b", vector: new Float32Array([0, 1, 0, 0]) },
    { id: 3, name: "tag-c", vector: new Float32Array([0, 0, 1, 0]) },
  ];

  const searchFn = async (queryVec: VectorLike, topK: number): Promise<VectorHit[]> => {
    const scored = tagDb.map((t) => ({
      id: t.id,
      score: t.vector.reduce(
        (sum, v, i) => sum + v * at(queryVec, i, "query vector"),
        0,
      ),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  };

  const lookupFn = async (ids: readonly number[]) => {
    return tagDb.filter((t) => ids.includes(t.id));
  };

  const rp = new TagResidualDecomposition({ dimension: dim, maxLevels: 2, topK: 3 });
  const queryVec = new Float32Array([1, 0.5, 0, 0]);
  const result = await rp.analyze(queryVec, { searchFn, lookupFn });

  assert.ok(result.levels.length > 0, "should have at least 1 level");
  assert.ok(result.totalExplainedEnergy > 0, "should explain some energy");
  assert.ok(result.features.coverage >= 0 && result.features.coverage <= 1);
  assert.ok(result.features.novelty >= 0 && result.features.novelty <= 1);
  assert.ok(result.finalResidual, "should have final residual");
});

test("TagResidualDecomposition.extractFeatures computes coverage and novelty", () => {
  const rp = new TagResidualDecomposition({ dimension: 4 });
  const tagResidualDecomposition = {
    levels: [
      {
        level: 0,
        tags: [],
        residualDirectionFeatures: {
          directionCoherence: 0.5,
          meanPairwiseDirectionSimilarity: 0.7,
          noveltySignal: 0.5,
          directionDispersionHeuristic: 0.15,
        },
      },
    ],
    totalExplainedEnergy: 0.8,
    finalResidual: new Float32Array([0.1, 0, 0, 0]),
  };

  const features = rp.extractFeatures(tagResidualDecomposition);
  assert.ok(features.coverage > 0.7 && features.coverage <= 1.0);
  assert.ok(features.novelty >= 0 && features.novelty <= 1);
  assert.ok(features.coherence === 0.7);
  assert.ok(features.propagationReadiness >= 0 && features.propagationReadiness <= 1);
});

test("TagResidualDecomposition.extractFeatures handles empty residual levels", () => {
  const rp = new TagResidualDecomposition({ dimension: 4 });
  const features = rp.extractFeatures({ levels: [], totalExplainedEnergy: 0 });
  assert.strictEqual(features.depth, 0);
  assert.strictEqual(features.coverage, 0);
  assert.strictEqual(features.novelty, 1);
});
