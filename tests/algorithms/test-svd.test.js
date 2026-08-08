'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  clusterTags,
  computeWeightedPCA,
  powerIteration,
  selectBasisDimension
} = require('../../src/algorithms/svd');

test('clusterTags groups similar vectors into k clusters', () => {
  const dim = 4;
  const tags = [
    { id: 1, name: 'a', vector: new Float32Array([1, 0, 0, 0]) },
    { id: 2, name: 'b', vector: new Float32Array([0.9, 0.1, 0, 0]) },
    { id: 3, name: 'c', vector: new Float32Array([0, 1, 0, 0]) },
    { id: 4, name: 'd', vector: new Float32Array([0, 0.9, 0.1, 0]) },
    { id: 5, name: 'e', vector: new Float32Array([0, 0, 1, 0]) },
    { id: 6, name: 'f', vector: new Float32Array([0, 0, 0.9, 0.1]) },
    { id: 7, name: 'g', vector: new Float32Array([0.1, 0, 0, 0.9]) },
    { id: 8, name: 'h', vector: new Float32Array([0, 0.1, 0, 0.9]) }
  ];
  const result = clusterTags(tags, 4, dim);
  assert.strictEqual(result.vectors.length, 4);
  assert.strictEqual(result.labels.length, 4);
  assert.strictEqual(result.weights.length, 4);
  assert.ok(result.weights.every(w => w > 0), 'all clusters should have members');
});

test('computeWeightedPCA extracts principal components', () => {
  const dim = 4;
  const vectors = [
    new Float32Array([1, 1, 0, 0]),
    new Float32Array([0.9, 0.9, 0.1, 0]),
    new Float32Array([1.1, 1.0, 0, 0.1]),
    new Float32Array([0, 0, 1, 1]),
    new Float32Array([0.1, 0, 0.9, 1.1])
  ];
  const weights = [1, 1, 1, 1, 1];
  const labels = ['a', 'b', 'c', 'd', 'e'];

  const result = computeWeightedPCA({ vectors, weights, labels }, dim, { maxBasisDim: 3 });
  assert.ok(result.U.length > 0, 'should produce at least one basis vector');
  assert.ok(result.S.length > 0, 'should produce at least one eigenvalue');
  assert.ok(result.meanVector, 'should produce mean vector');
  assert.strictEqual(result.U[0].length, dim, 'basis vector should have correct dimension');

  // First eigenvalue should be largest
  for (let i = 1; i < result.S.length; i++) {
    assert.ok(result.S[i] <= result.S[0], 'eigenvalues should be in descending order');
  }
});

test('selectBasisDimension selects components explaining 95% variance', () => {
  const S = [100, 5, 1, 0.1];
  const k = selectBasisDimension(S);
  assert.ok(k >= 1, 'should select at least 1 component');
  assert.ok(k <= 4, 'should not exceed available components');
});

test('selectBasisDimension returns at least 8 when possible', () => {
  const S = Array(20).fill(0).map((_, i) => 100 - i * 5);
  const k = selectBasisDimension(S);
  assert.ok(k >= 8, 'should return at least 8 components for well-distributed eigenvalues');
});
