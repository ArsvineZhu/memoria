import assert from "node:assert/strict";
import { test } from "node:test";

import { EPA } from "../../src/algorithms/epa.js";
import { dotProduct, orthogonalProjection } from "../../src/algorithms/gram-schmidt.js";
import { ResidualPyramid } from "../../src/algorithms/residual-pyramid.js";
import {
  clusterTags,
  computeWeightedPCA,
  powerIteration,
  selectBasisDimension,
} from "../../src/algorithms/svd.js";
import {
  at,
  assertFiniteVector,
  assertVectorDimension,
} from "../../src/utils/numerical.js";

test("checked numerical helpers reject out-of-bounds, dimensions, and non-finite values", () => {
  assert.throws(() => at([1], 1, "values"), RangeError);
  assert.throws(() => assertVectorDimension(new Float32Array(2), 3), RangeError);
  assert.throws(
    () => assertFiniteVector(new Float32Array([1, Number.NaN])),
    RangeError,
  );
});

test("Gram-Schmidt rejects mismatched and non-finite vectors", () => {
  assert.throws(() => dotProduct([1, 2], [1]), RangeError);
  assert.throws(() => dotProduct([1, Number.POSITIVE_INFINITY], [1, 2]), RangeError);
  assert.throws(
    () =>
      orthogonalProjection(new Float32Array([1, 0]), [new Float32Array([1, 0, 0])], 2),
    RangeError,
  );
});

test("PCA handles empty input and rejects invalid weights or vectors", () => {
  const empty = computeWeightedPCA({ vectors: [], weights: [], labels: [] }, 3);
  assert.equal(empty.U.length, 0);
  assert.equal(empty.meanVector.length, 3);
  assert.equal(selectBasisDimension([]), 0);

  assert.throws(
    () =>
      computeWeightedPCA(
        { vectors: [new Float32Array([1, 0])], weights: [-1], labels: ["bad"] },
        2,
      ),
    RangeError,
  );
  assert.throws(
    () =>
      computeWeightedPCA(
        { vectors: [new Float32Array([1, Number.NaN])], weights: [1], labels: ["bad"] },
        2,
      ),
    RangeError,
  );
  assert.throws(() => selectBasisDimension([1, Number.NaN]), RangeError);
});

test("SVD matrix and native-vector boundaries reject malformed data", () => {
  assert.throws(() => powerIteration(new Float32Array([1, 0, 0]), 2, []), RangeError);
  assert.throws(
    () =>
      clusterTags([{ id: 1, name: "bad", vector: new Float32Array([1, 0, 0]) }], 1, 2),
    RangeError,
  );
  assert.throws(
    () => clusterTags([{ id: 1, name: "bad", vector: Buffer.alloc(4) }], 1, 2),
    RangeError,
  );
});

test("EPA and residual pyramid reject invalid query vectors at their public boundaries", async () => {
  const epa = new EPA(
    {
      orthoBasis: [new Float32Array([1, 0])],
      basisMean: new Float32Array([0, 0]),
    },
    { dimension: 2 },
  );
  assert.throws(() => epa.project(new Float32Array([Number.NaN, 0])), RangeError);

  const pyramid = new ResidualPyramid({ dimension: 2 });
  await assert.rejects(
    () =>
      pyramid.analyze(new Float32Array([1, 0, 0]), {
        searchFn: async () => [],
        lookupFn: async () => [],
      }),
    RangeError,
  );
});
