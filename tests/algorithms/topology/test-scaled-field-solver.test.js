'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildRowOperator,
  solveDualScaledFields,
  normalizeSource,
  effectiveSupport
} = require('../../../src/algorithms/topology/scaled-field-solver');

function makeLineGraph(nodeCount) {
  const adjacency = new Map();
  for (let id = 1; id <= nodeCount; id++) {
    const row = new Map();
    if (id > 1) row.set(id - 1, 1);
    if (id < nodeCount) row.set(id + 1, 1);
    adjacency.set(id, row);
  }
  return adjacency;
}

test('buildRowOperator builds deterministic row-normalized operator', () => {
  const operator = buildRowOperator(makeLineGraph(4));
  assert.strictEqual(operator.nodeCount, 4);
  assert.strictEqual(operator.nodeIndexOf(3), 2);
  assert.strictEqual(operator.nodeIdAt(2), 3);

  const input = new Float64Array([0, 1, 0, 0]);
  const output = operator.apply(input);
  assert.strictEqual(output[0], 0.5);
  assert.strictEqual(output[2], 0.5);
  assert.strictEqual(output[1], 0);
  assert.strictEqual(output[3], 0);
});

test('buildRowOperator forEachEdge walks a given source row', () => {
  const operator = buildRowOperator(makeLineGraph(3));
  const seen = [];
  operator.forEachEdge(2, (targetId, weight) => seen.push([targetId, weight]));
  assert.deepStrictEqual(seen, [[1, 1], [3, 1]]);
});

test('normalizeSource normalizes a Map source to unit mass', () => {
  const operator = buildRowOperator(makeLineGraph(4));
  const source = normalizeSource(operator, new Map([[2, 3], [4, 1]]));
  assert.strictEqual(source.length, 4);
  assert.strictEqual(source[0], 0);
  assert.strictEqual(source[1], 0.75);
  assert.strictEqual(source[2], 0);
  assert.strictEqual(source[3], 0.25);
});

test('normalizeSource throws TAGMEMO_V10_EMPTY_SOURCE on no positive mass', () => {
  const operator = buildRowOperator(makeLineGraph(4));
  assert.throws(
    () => normalizeSource(operator, new Map([[1, 0], [2, -5]])),
    (error) => error.code === 'TAGMEMO_V10_EMPTY_SOURCE'
  );
});

test('effectiveSupport mass_ratio keeps the head of the distribution', () => {
  const operator = buildRowOperator(makeLineGraph(3));
  const support = effectiveSupport(
    new Float64Array([0.5, 0.3, 0.2]),
    operator,
    { method: 'mass_ratio', massRatio: 0.6 }
  );
  assert.deepStrictEqual(support.ids, [1, 2]);
  assert.strictEqual(support.size, 2);
  assert.ok(support.retainedMassRatio >= 0.6);
  assert.ok(support.shannonEffectiveSize > 0);
  assert.ok(support.participationRatio > 0);
});

test('effectiveSupport empty vector returns empty domain', () => {
  const operator = buildRowOperator(makeLineGraph(3));
  const support = effectiveSupport(new Float64Array([0, 0, 0]), operator);
  assert.strictEqual(support.size, 0);
  assert.deepStrictEqual(support.ids, []);
  assert.strictEqual(support.shannonEffectiveSize, 0);
});

test('solveDualScaledFields converges local and transfer fields on a line graph', () => {
  const operator = buildRowOperator(makeLineGraph(5));
  const source = new Map([[3, 1]]);
  const result = solveDualScaledFields({
    operator,
    sourceField: source
  });

  assert.ok(result.diagnostics.converged, 'both fields should converge');
  assert.ok(result.diagnostics.iterations <= 80, 'iteration cap respected');
  assert.ok(result.diagnostics.localResidual < 1e-9);
  assert.ok(result.diagnostics.transferResidual < 1e-9);
  assert.ok(result.diagnostics.operatorShared === true);

  const sourceId = 3;
  const sourceIndex = operator.nodeIndexOf(sourceId);
  assert.strictEqual(result.sourceVector[sourceIndex], 1);

  const localIds = result.localDomain.ids;
  assert.ok(localIds.includes(sourceId), 'source node in local support');
  assert.strictEqual(
    result.transferDomain.size >= result.localDomain.size,
    true,
    'transfer scale spreads wider than local'
  );
  assert.ok(
    result.diagnostics.iterationTrace.length === result.diagnostics.iterations,
    'iteration trace complete'
  );
});

test('solveDualScaledFields propagates mass away from the source', () => {
  const operator = buildRowOperator(makeLineGraph(7));
  const result = solveDualScaledFields({
    operator,
    sourceField: new Map([[4, 1]])
  });

  const sourceIndex = operator.nodeIndexOf(4);
  const neighborOffsets = [-1, 1];
  for (const offset of neighborOffsets) {
    assert.ok(
      result.transferVector[sourceIndex + offset] > 0,
      `transfer reaches neighbor ${offset}`
    );
    assert.ok(
      result.localVector[sourceIndex + offset] > 0,
      `local reaches neighbor ${offset}`
    );
  }
  assert.ok(result.transferVector[0] >= result.localVector[0], 'transfer tail heavier than local');
});

test('solveDualScaledFields rejects mismatched operator spaces', () => {
  const local = buildRowOperator(makeLineGraph(4));
  const transfer = buildRowOperator(makeLineGraph(5));
  assert.throws(
    () => solveDualScaledFields({ localOperator: local, transferOperator: transfer, sourceField: new Map([[1, 1]]) }),
    /must share the same node space/
  );
});

test('solveDualScaledFields throws without operators', () => {
  assert.throws(
    () => solveDualScaledFields({ sourceField: new Map([[1, 1]]) }),
    /requires conditioned operators/
  );
});