'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  dotProduct,
  magnitude,
  normalize,
  orthogonalize,
  orthogonalProjection
} = require('../../src/algorithms/gram-schmidt');

test('dotProduct computes inner product', () => {
  const a = new Float32Array([1, 2, 3]);
  const b = new Float32Array([4, 5, 6]);
  assert.strictEqual(dotProduct(a, b), 32); // 1*4 + 2*5 + 3*6
});

test('magnitude computes L2 norm', () => {
  const v = new Float32Array([3, 4]);
  assert.strictEqual(magnitude(v), 5);
});

test('normalize returns unit vector', () => {
  const v = new Float32Array([3, 4]);
  const n = normalize(v);
  assert.ok(Math.abs(magnitude(n) - 1) < 1e-5, 'normalized vector should be unit length');
});

test('orthogonalize produces orthogonal basis (Modified Gram-Schmidt)', () => {
  const dim = 3;
  const vectors = [
    new Float32Array([1, 0, 0]),
    new Float32Array([1, 1, 0]),
    new Float32Array([1, 1, 1])
  ];
  const { basis, basisCoefficients } = orthogonalize(vectors, dim);

  // Each basis vector should be unit length
  for (const b of basis) {
    assert.ok(Math.abs(magnitude(b) - 1) < 1e-5, 'basis vector should be unit length');
  }

  // Basis vectors should be mutually orthogonal
  for (let i = 0; i < basis.length; i++) {
    for (let j = i + 1; j < basis.length; j++) {
      const dot = dotProduct(basis[i], basis[j]);
      assert.ok(Math.abs(dot) < 1e-5, `basis ${i} and ${j} should be orthogonal, dot=${dot}`);
    }
  }
  assert.strictEqual(basis.length, 3);
});

test('orthogonalize handles linearly dependent vectors', () => {
  const dim = 2;
  const vectors = [
    new Float32Array([1, 0]),
    new Float32Array([2, 0]) // collinear with first
  ];
  const { basis, basisCoefficients } = orthogonalize(vectors, dim);
  assert.strictEqual(basis.length, 1); // only 1 independent vector
  assert.strictEqual(basisCoefficients[1], 0); // second has no contribution
});

test('orthogonalProjection projects vector onto subspace and returns residual', () => {
  const dim = 3;
  const vector = new Float32Array([1, 1, 1]);
  const tags = [
    new Float32Array([1, 0, 0]),
    new Float32Array([0, 1, 0])
  ];
  const { projection, residual } = orthogonalProjection(vector, tags, dim);

  // Projection should be [1, 1, 0]
  assert.ok(Math.abs(projection[0] - 1) < 1e-5);
  assert.ok(Math.abs(projection[1] - 1) < 1e-5);
  assert.ok(Math.abs(projection[2]) < 1e-5);

  // Residual should be [0, 0, 1]
  assert.ok(Math.abs(residual[0]) < 1e-5);
  assert.ok(Math.abs(residual[1]) < 1e-5);
  assert.ok(Math.abs(residual[2] - 1) < 1e-5);

  // Energy conservation: ||v||^2 = ||P||^2 + ||R||^2
  const eOrig = magnitude(vector) ** 2;
  const eProj = magnitude(projection) ** 2;
  const eRes = magnitude(residual) ** 2;
  assert.ok(Math.abs(eOrig - (eProj + eRes)) < 1e-4, 'energy should be conserved');
});
