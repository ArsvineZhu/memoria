'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EPA } = require('../../src/algorithms/epa');

test('EPA.project returns empty result when not initialized', () => {
  const epa = new EPA({});
  const result = epa.project(new Float32Array([1, 0, 0]));
  assert.strictEqual(result.logicDepth, 0);
  assert.strictEqual(result.dominantAxes.length, 0);
});

test('EPA.project computes logic depth from orthogonal basis', () => {
  const dim = 4;
  const orthoBasis = [
    new Float32Array([1, 0, 0, 0]),
    new Float32Array([0, 1, 0, 0])
  ];
  const basisMean = new Float32Array([0, 0, 0, 0]);
  const basisLabels = ['axis-x', 'axis-y'];
  const basisEnergies = [1.0, 0.5];

  const epa = new EPA({ orthoBasis, basisMean, basisLabels, basisEnergies, dimension: dim });

  const focused = new Float32Array([1, 0, 0, 0]);
  const focusedResult = epa.project(focused);
  assert.ok(focusedResult.logicDepth > 0.5, 'focused vector should have high logic depth');

  const spread = new Float32Array([1, 1, 0, 0]);
  const spreadResult = epa.project(spread);
  assert.ok(spreadResult.logicDepth < focusedResult.logicDepth, 'spread vector should have lower logic depth');
});

test('EPA.detectCrossDomainResonance detects multi-axis activation', () => {
  const dim = 4;
  const orthoBasis = [
    new Float32Array([1, 0, 0, 0]),
    new Float32Array([0, 1, 0, 0])
  ];
  const basisMean = new Float32Array([0, 0, 0, 0]);
  const basisLabels = ['domain-a', 'domain-b'];
  const basisEnergies = [1.0, 1.0];

  const epa = new EPA({ orthoBasis, basisMean, basisLabels, basisEnergies, dimension: dim });

  const crossDomain = new Float32Array([1, 1, 0, 0]);
  const result = epa.detectCrossDomainResonance(crossDomain);
  assert.ok(result.resonance > 0, 'should detect resonance');
  assert.ok(result.bridges.length > 0, 'should have bridges');
});

test('EPA.detectCrossDomainResonance returns zero for single-axis activation', () => {
  const dim = 4;
  const orthoBasis = [
    new Float32Array([1, 0, 0, 0]),
    new Float32Array([0, 1, 0, 0])
  ];
  const basisMean = new Float32Array([0, 0, 0, 0]);
  const basisLabels = ['domain-a', 'domain-b'];
  const basisEnergies = [1.0, 0.01];

  const epa = new EPA({ orthoBasis, basisMean, basisLabels, basisEnergies, dimension: dim });

  const singleDomain = new Float32Array([1, 0, 0, 0]);
  const result = epa.detectCrossDomainResonance(singleDomain);
  assert.strictEqual(result.resonance, 0);
  assert.strictEqual(result.bridges.length, 0);
});

test('EPA.computeBasis builds basis from tag vectors', () => {
  const dim = 4;
  const tags = [];
  for (let i = 0; i < 5; i++) {
    tags.push({
      id: i + 1,
      name: `cluster-a-${i}`,
      vector: new Float32Array([1 + Math.random() * 0.1, 0, 0, 0])
    });
  }
  for (let i = 0; i < 5; i++) {
    tags.push({
      id: i + 6,
      name: `cluster-b-${i}`,
      vector: new Float32Array([0, 0, 1 + Math.random() * 0.1, 0])
    });
  }

  const basis = EPA.computeBasis(tags, dim, { clusterCount: 4, maxBasisDim: 4 });
  assert.ok(basis.orthoBasis, 'should produce orthoBasis');
  assert.ok(basis.orthoBasis.length > 0, 'should have at least 1 basis vector');
  assert.ok(basis.basisMean, 'should produce basisMean');
  assert.strictEqual(basis.orthoBasis[0].length, dim);
});
