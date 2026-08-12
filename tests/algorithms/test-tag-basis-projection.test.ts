"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { TagBasisProjection } from "../../src/algorithms/tag-basis-projection.js";
import { at } from "../../src/utils/numerical.js";

test("TagBasisProjection.project returns empty result when not initialized", () => {
  const tagBasisProjection = new TagBasisProjection({});
  const result = tagBasisProjection.project(new Float32Array([1, 0, 0]));
  assert.strictEqual(result.projectionConcentration, 0);
  assert.strictEqual(result.dominantAxes.length, 0);
});

test("TagBasisProjection.project computes projection concentration from orthogonal basis", () => {
  const dim = 4;
  const orthoBasis = [new Float32Array([1, 0, 0, 0]), new Float32Array([0, 1, 0, 0])];
  const basisMean = new Float32Array([0, 0, 0, 0]);
  const basisLabels = ["axis-x", "axis-y"];
  const basisEnergies = [1.0, 0.5];

  const tagBasisProjection = new TagBasisProjection({
    orthoBasis,
    basisMean,
    basisLabels,
    basisEnergies,
    dimension: dim,
  });

  const focused = new Float32Array([1, 0, 0, 0]);
  const focusedResult = tagBasisProjection.project(focused);
  assert.ok(
    focusedResult.projectionConcentration > 0.5,
    "focused vector should have high projection concentration",
  );

  const spread = new Float32Array([1, 1, 0, 0]);
  const spreadResult = tagBasisProjection.project(spread);
  assert.ok(
    spreadResult.projectionConcentration < focusedResult.projectionConcentration,
    "spread vector should have lower projection concentration",
  );
});

test("TagBasisProjection.detectCrossDomainAxisCoactivation detects multi-axis activation", () => {
  const dim = 4;
  const orthoBasis = [new Float32Array([1, 0, 0, 0]), new Float32Array([0, 1, 0, 0])];
  const basisMean = new Float32Array([0, 0, 0, 0]);
  const basisLabels = ["domain-a", "domain-b"];
  const basisEnergies = [1.0, 1.0];

  const tagBasisProjection = new TagBasisProjection({
    orthoBasis,
    basisMean,
    basisLabels,
    basisEnergies,
    dimension: dim,
  });

  const crossDomain = new Float32Array([1, 1, 0, 0]);
  const result = tagBasisProjection.detectCrossDomainAxisCoactivation(crossDomain);
  assert.ok(result.axisCoactivation > 0, "should detect axisCoactivation");
  assert.ok(result.coactiveAxisPairs.length > 0, "should have coactiveAxisPairs");
});

test("TagBasisProjection.detectCrossDomainAxisCoactivation returns zero for single-axis activation", () => {
  const dim = 4;
  const orthoBasis = [new Float32Array([1, 0, 0, 0]), new Float32Array([0, 1, 0, 0])];
  const basisMean = new Float32Array([0, 0, 0, 0]);
  const basisLabels = ["domain-a", "domain-b"];
  const basisEnergies = [1.0, 0.01];

  const tagBasisProjection = new TagBasisProjection({
    orthoBasis,
    basisMean,
    basisLabels,
    basisEnergies,
    dimension: dim,
  });

  const singleDomain = new Float32Array([1, 0, 0, 0]);
  const result = tagBasisProjection.detectCrossDomainAxisCoactivation(singleDomain);
  assert.strictEqual(result.axisCoactivation, 0);
  assert.strictEqual(result.coactiveAxisPairs.length, 0);
});

test("TagBasisProjection.computeBasis builds basis from tag vectors", () => {
  const dim = 4;
  const tags = [];
  for (let i = 0; i < 5; i++) {
    tags.push({
      id: i + 1,
      name: `cluster-a-${i}`,
      vector: new Float32Array([1 + Math.random() * 0.1, 0, 0, 0]),
    });
  }
  for (let i = 0; i < 5; i++) {
    tags.push({
      id: i + 6,
      name: `cluster-b-${i}`,
      vector: new Float32Array([0, 0, 1 + Math.random() * 0.1, 0]),
    });
  }

  const basis = TagBasisProjection.computeBasis(tags, dim, {
    clusterCount: 4,
    maxBasisDim: 4,
  });
  assert.ok(basis.orthoBasis, "should produce orthoBasis");
  assert.ok(basis.orthoBasis.length > 0, "should have at least 1 basis vector");
  assert.ok(basis.basisMean, "should produce basisMean");
  assert.strictEqual(at(basis.orthoBasis, 0, "TagBasisProjection basis").length, dim);
});
