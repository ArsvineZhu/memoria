'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const PipelineContext = require('../../src/core/context');
const SqliteMetadataStore = require('../../src/providers/sqlite-metadata-store');
const { encodeVectorBlob } = require('../../src/utils/vector-codec');
const CandidateMergerStage = require('../../src/stages/retrieval/candidate-merger');

const { propagate, computeFirWeights } = require('../../src/algorithms/wave-propagation');
const { computeRiverObservability } = require('../../src/algorithms/topology/river-observability');
const {
  buildRowOperator,
  solveDualScaledFields
} = require('../../src/algorithms/topology/scaled-field-solver');

const TagMemoV9Stage = require('../../src/stages/memo/tagmemo-v9');
const TagMemoV10Stage = require('../../src/stages/memo/tagmemo-v10');
const RiverMemoStage = require('../../src/stages/memo/rivermemo');

const dim = 4;

function vec(...components) {
  return new Float32Array(components);
}

function adjacency(...rows) {
  const graph = new Map();
  for (const [from, neighbors] of rows) {
    graph.set(Number(from), new Map(
      Object.entries(neighbors).map(([to, weight]) => [Number(to), Number(weight)])
    ));
  }
  return graph;
}

// ── wave propagation (pure algorithm) ──────────────────────────────────────

test('wave propagation: activations decay monotonically along a directed line', () => {
  const graph = adjacency([0, { 1: 1.0 }], [1, { 2: 1.0 }], [2, {}]);
  const result = propagate({
    sources: [{ id: 0, energy: 1 }],
    graph,
    config: {}
  });

  const activations = result.activations;
  assert.ok(activations instanceof Map, 'activations must be a Map');
  const e0 = activations.get(0);
  const e1 = activations.get(1);
  const e2 = activations.get(2);
  assert.ok(e0 > e1 && e1 > e2 && e2 > 0, 'energy must decay monotonically along the line');
  assert.strictEqual(result.iterations, 2, 'two rounds of propagation happened');

  // FIR-weighted readout: seed energy * normalized fir weight[0].
  const [w0, w1, w2] = computeFirWeights(0.6, 4);
  assert.ok(Math.abs(e0 - 1 * w0) < 1e-6, 'seed activation = energy * fir[0]');
  assert.ok(Math.abs(e1 - 0.7 * w1) < 1e-6, 'edge at tension 1.0 is a wormhole: decay 0.7');
  assert.ok(Math.abs(e2 - 0.49 * w2) < 1e-6, 'second hop continues the wormhole decay');
});

test('wave propagation: seed without neighbors still activates only the seed node', () => {
  const result = propagate({
    sources: [{ id: 0, energy: 1 }],
    config: {}
  });
  assert.strictEqual(result.activations.size, 1);
  const [w0] = computeFirWeights(0.6, 4);
  assert.ok(Math.abs(result.activations.get(0) - w0) < 1e-6);
  assert.strictEqual(result.iterations, 0, 'no reachable neighbors => no propagation rounds');
});

test('wave propagation: zero hops leaves only seed activations', () => {
  const graph = adjacency([0, { 1: 1.0 }], [1, {}]);
  const result = propagate({
    sources: [{ id: 0, energy: 1 }],
    graph,
    config: { maxSafeHops: 0 }
  });
  assert.strictEqual(result.activations.size, 1);
  assert.strictEqual(result.activations.get(1), undefined);
  assert.strictEqual(result.iterations, 0);
});

test('wave propagation: branching limit keeps only the strongest neighbors', () => {
  const graph = adjacency([0, { 1: 1.0, 2: 0.8, 3: 0.7 }], [1, {}], [2, {}], [3, {}]);
  const result = propagate({
    sources: [{ id: 0, energy: 1 }],
    graph,
    config: { maxNeighborsPerNode: 2, tensionThreshold: 10 }
  });
  assert.ok(result.activations.has(1));
  assert.ok(result.activations.has(2));
  assert.strictEqual(result.activations.get(3), undefined, 'weakest neighbor must not fire');
});

test('wave propagation: wormhole edges keep momentum and reach further nodes', () => {
  const graph = adjacency(
    [0, { 1: 1.0 }],
    [1, { 2: 1.0 }],
    [2, { 3: 1.0 }],
    [3, {}]
  );
  const without = propagate({
    sources: [{ id: 0, energy: 1 }],
    graph,
    config: { tensionThreshold: 10 }
  });
  assert.strictEqual(without.activations.get(3), undefined,
    'ordinary edges exhaust momentum before the third hop');

  const withWormhole = propagate({
    sources: [{ id: 0, energy: 1 }],
    graph,
    wormholeEdges: new Set(['1:2']),
    config: { tensionThreshold: 10 }
  });
  assert.ok(withWormhole.activations.get(3) > 0,
    'a wormhole edge lets the spike bypass the momentum cost');
});

test('wave propagation: pruneAbove drops weak activations relative to the peak', () => {
  const graph = adjacency([0, { 1: 0.5 }], [1, { 2: 0.5 }], [2, {}]);
  const result = propagate({
    sources: [{ id: 0, energy: 1 }],
    graph,
    config: { tensionThreshold: 10, pruneAbove: 0.9 }
  });
  assert.ok(result.activations.get(0) > 0);
  assert.strictEqual(result.activations.get(1), undefined, 'weak node pruned below 90% of peak');
  assert.ok(result.diagnostics.prunedNodeCount >= 1);
});

test('wave propagation: neighborFn callback replaces an inline graph', () => {
  const calls = [];
  const result = propagate({
    sources: [{ id: 7, energy: 1 }],
    neighborFn: (id) => {
      calls.push(id);
      if (id === 7) return new Map([[5, 0.5]]);
      return new Map();
    },
    config: { tensionThreshold: 10 }
  });
  assert.deepStrictEqual(calls, [7, 5]);
  assert.ok(result.activations.has(5));
  const [, w1] = computeFirWeights(0.6, 4);
  assert.ok(Math.abs(result.activations.get(5) - 0.5 * 0.25 * w1) < 1e-6,
    'ordinary edge uses baseDecay 0.25');
});

// ── river observability (pure topology) ────────────────────────────────────

test('computeRiverObservability: empty river collapses, rich river turns dense', () => {
  const collapsed = computeRiverObservability({
    queryRiverGraph: { diagnostics: {} }
  });
  assert.strictEqual(collapsed.regime, 'collapsed');
  assert.strictEqual(collapsed.omega, 0);

  const river = {
    diagnostics: { seedNodes: 2, reachedNodes: 8, activeEdges: 9 },
    nodes: [
      { id: 1, hop: 0 }, { id: 2, hop: 0 }, { id: 3, hop: 1 }, { id: 4, hop: 1 },
      { id: 5, hop: 2 }, { id: 6, hop: 2 }, { id: 7, hop: 3 }, { id: 8, hop: 3 },
      { id: 9, hop: 4 }
    ],
    edges: Array.from({ length: 9 }, () => ({ flow: 0.5 }))
  };
  const dense = computeRiverObservability({ queryRiverGraph: river });
  assert.ok(dense.omega > 0.4, 'rich river should classify as dense');
  assert.strictEqual(dense.regime, 'dense');
});

// ── scaled field solver (pure topology) ───────────────────────────────────

test('solve dual scaled fields converges on a line graph and derives domains', () => {
  const graph = adjacency(
    [1, { 2: 1 }],
    [2, { 1: 1, 3: 1 }],
    [3, { 2: 1, 4: 1 }],
    [4, { 3: 1 }]
  );
  const operator = buildRowOperator(graph);
  const solved = solveDualScaledFields({
    localOperator: operator,
    transferOperator: operator,
    sourceField: [[4, 1]],
    local: { alpha: 0.15, maxIterations: 200, tolerance: 1e-9 },
    transfer: { alpha: 0.55, maxIterations: 200, tolerance: 1e-9 },
    support: { method: 'mass_ratio', massRatio: 0.8, localMassRatio: 0.8, transferMassRatio: 0.9 }
  });
  assert.strictEqual(solved.diagnostics.converged, true);
  assert.ok(solved.localDomain.ids.length >= 1, 'local domain must be derived');
  assert.ok(solved.transferDomain.ids.length >= 1, 'transfer domain must be derived');
});

// ── TagMemoV9Stage ─────────────────────────────────────────────────────────

async function seedTagMemoStore() {
  const metaStore = new SqliteMetadataStore({ dbPath: ':memory:', dimension: dim });
  const f1 = await metaStore.upsertFile({ path: 'a.md', diaryName: 'd', checksum: 'a', mtime: 1, size: 1 });
  const f2 = await metaStore.upsertFile({ path: 'b.md', diaryName: 'd', checksum: 'b', mtime: 1, size: 1 });
  const [c1] = await metaStore.insertChunks(f1, [
    { chunkIndex: 0, content: 'candidate a', vector: encodeVectorBlob(vec(1, 0, 0, 0)) }
  ]);
  const [c2] = await metaStore.insertChunks(f2, [
    { chunkIndex: 0, content: 'candidate b', vector: encodeVectorBlob(vec(0, 1, 0, 0)) }
  ]);
  const [t1, t2, t3] = await metaStore.upsertTags([
    { name: 'alpha', vector: encodeVectorBlob(vec(1, 0, 0, 0)) },
    { name: 'beta', vector: encodeVectorBlob(vec(0, 1, 0, 0)) },
    { name: 'gamma', vector: encodeVectorBlob(vec(0, 0, 1, 0)) }
  ]);
  await metaStore.setFileTags(f1, [t1, t2]);
  await metaStore.setFileTags(f2, [t2, t3]);
  return { metaStore, t1, t2, t3, c1, c2 };
}

function miniGraph9() {
  return adjacency(
    [1, { 2: 1.5, 3: 1.0 }],
    [2, { 1: 1.5, 3: 4.0 }],
    [3, { 1: 1.0, 2: 4.0 }]
  );
}

const pyramidSeeds = {
  levels: [{ level: 0, tags: [{ id: 1, name: 'alpha', contribution: 0.5 }] }],
  features: { coverage: 0.2, novelty: 0.5, coherence: 0.3, tagMemoActivation: 0.5, depth: 1 }
};

test('TagMemoV9Stage: activates the tag graph and emits the energy field', async () => {
  const stage = new TagMemoV9Stage();
  assert.strictEqual(stage.name, 'tagMemoV9');

  const { metaStore, c1 } = await seedTagMemoStore();
  const ctx = new PipelineContext({
    config: { tagMemoV9Enabled: true, dimension: dim },
    metadataStore: metaStore,
    tagGraph: miniGraph9()
  });
  const input = {
    queryVector: vec(1, 0, 0, 0),
    pyramid: pyramidSeeds,
    mergedCandidates: [{ chunkId: c1, score: 0.7 }]
  };

  const out = await stage.process(input, ctx);
  assert.ok(out.tagMemo, 'tagMemo must be attached');
  assert.strictEqual(out.tagMemo.version, 'v9');
  assert.ok(out.tagMemo.activations instanceof Map, 'activations must be a Map');
  assert.ok(out.tagMemo.activations.size >= 3, 'emergent nodes must join the seeds');
  assert.ok(out.tagMemo.activations.get(1) > 0, 'seed node activation must be positive');

  assert.ok(Array.isArray(out.tagMemo.ranked), 'ranked must be a sorted list');
  assert.strictEqual(out.tagMemo.ranked[0].id, 1, 'seed should lead by energy');
  assert.strictEqual(out.tagMemo.ranked[0].name, 'alpha', 'names should be resolved');

  assert.ok(out.tagMemo.iterations >= 0);
  assert.ok(out.tagMemo.riverGraph, 'river graph must be attached');
  assert.ok(Array.isArray(out.tagMemo.riverGraph.nodes));
  assert.ok(Array.isArray(out.tagMemo.riverGraph.edges));
});

test('TagMemoV9Stage: deterministic across identical runs', async () => {
  const stage = new TagMemoV9Stage();
  const { metaStore, c1 } = await seedTagMemoStore();
  const cx = () => new PipelineContext({
    config: { tagMemoV9Enabled: true, dimension: dim },
    metadataStore: metaStore,
    tagGraph: miniGraph9()
  });
  const input = () => ({
    queryVector: vec(1, 0, 0, 0),
    pyramid: pyramidSeeds,
    mergedCandidates: [{ chunkId: c1, score: 0.7 }]
  });

  const a = await stage.process(input(), cx());
  const b = await stage.process(input(), cx());
  assert.deepStrictEqual(
    [...a.tagMemo.activations],
    [...b.tagMemo.activations],
    'activations must be identical'
  );
  assert.deepStrictEqual(a.tagMemo.riverGraph, b.tagMemo.riverGraph);
});

test('TagMemoV9Stage: disabled by config is a passthrough', async () => {
  const stage = new TagMemoV9Stage();
  const { metaStore, c1 } = await seedTagMemoStore();
  const ctx = new PipelineContext({
    config: { tagMemoV9Enabled: false },
    metadataStore: metaStore,
    tagGraph: miniGraph9()
  });
  const input = { queryVector: vec(1, 0, 0, 0), mergedCandidates: [{ chunkId: c1, score: 0.7 }] };
  const out = await stage.process(input, ctx);
  assert.strictEqual(out.tagMemoSkipped, true);
  assert.deepStrictEqual(out.mergedCandidates, input.mergedCandidates);
});

test('TagMemoV9Stage: falls back to candidate tags when no pyramid is present', async () => {
  const stage = new TagMemoV9Stage();
  const { metaStore, c1 } = await seedTagMemoStore();
  const ctx = new PipelineContext({
    config: { tagMemoV9Enabled: true },
    metadataStore: metaStore,
    tagGraph: miniGraph9()
  });
  const out = await stage.process({
    queryVector: vec(1, 0, 0, 0),
    mergedCandidates: [{ chunkId: c1, score: 0.7, tags: ['alpha'] }]
  }, ctx);
  assert.ok(out.tagMemo, 'fallback seed path must still produce a tag memo');
  assert.ok(out.tagMemo.activations.get(1) > 0, 'alpha should be activated from candidate tags');
});

test('TagMemoV9Stage: no graph and no seeds short-circuits with a skip flag', async () => {
  const stage = new TagMemoV9Stage();
  const ctx = new PipelineContext({
    config: { tagMemoV9Enabled: true },
    metadataStore: null
  });
  const out = await stage.process({
    queryVector: vec(1, 0, 0, 0),
    mergedCandidates: []
  }, ctx);
  assert.strictEqual(out.tagMemoSkipped, true);
});

// ── TagMemoV10Stage ────────────────────────────────────────────────────────

test('TagMemoV10Stage: solves dual scaled fields over the v9 wave', async () => {
  const stage = new TagMemoV10Stage();
  assert.strictEqual(stage.name, 'tagMemoV10');

  const { metaStore, c1 } = await seedTagMemoStore();
  const ctx = new PipelineContext({
    config: {
      tagMemoV9Enabled: true,
      tagMemoV10Enabled: true,
      dimension: dim
    },
    metadataStore: metaStore,
    tagGraph: miniGraph9()
  });

  const v9 = await new TagMemoV9Stage().process({
    queryVector: vec(1, 0, 0, 0),
    pyramid: pyramidSeeds,
    mergedCandidates: [{ chunkId: c1, score: 0.7, tags: ['alpha', 'beta'] }]
  }, ctx);

  const out = await stage.process(v9, ctx);
  assert.ok(out.tagMemo, 'tagMemo must be attached');
  assert.strictEqual(out.tagMemo.version, 'v10');
  assert.ok(Array.isArray(out.tagMemo.sourceField) && out.tagMemo.sourceField.length > 0);
  assert.ok(Array.isArray(out.tagMemo.localField));
  assert.ok(Array.isArray(out.tagMemo.transferField));
  assert.ok(out.tagMemo.localDomain.ids.length >= 0);
  assert.ok(out.tagMemo.transferDomain.ids.length >= 0);
  assert.strictEqual(out.tagMemo.solverDiagnostics.converged, true);
  assert.ok(out.tagMemo.ranked.length >= 1, 'ranked list from the v10 field readout');
  assert.ok(Number.isFinite(out.tagMemo.sourceField[0][0]));
});

test('TagMemoV10Stage: v10 reranks candidates with domain overlap boost', async () => {
  const stage = new TagMemoV10Stage();
  const { metaStore, c1 } = await seedTagMemoStore();
  const ctx = new PipelineContext({
    config: { tagMemoV10Enabled: true, dimension: dim },
    metadataStore: metaStore,
    tagGraph: miniGraph9()
  });
  const v9 = await new TagMemoV9Stage().process({
    queryVector: vec(1, 0, 0, 0),
    pyramid: pyramidSeeds,
    mergedCandidates: [{ chunkId: c1, score: 0.7, tags: ['alpha', 'beta'] }]
  }, ctx);
  const out = await stage.process(v9, ctx);
  assert.ok(out.mergedCandidates.length >= 1, 'candidates survive v10 reranking');
  const candidate = out.mergedCandidates[0];
  assert.ok('topologyBonus' in candidate, 'candidate should carry the topology bonus');
  assert.ok(candidate.topologyBonus >= 0);
});

test('TagMemoV10Stage: disabled is a passthrough that keeps the v9 tag memo', async () => {
  const stage = new TagMemoV10Stage();
  const { metaStore, c1 } = await seedTagMemoStore();
  const ctx = new PipelineContext({
    config: { tagMemoV9Enabled: true, tagMemoV10Enabled: false },
    metadataStore: metaStore,
    tagGraph: miniGraph9()
  });
  const v9 = await new TagMemoV9Stage().process({
    queryVector: vec(1, 0, 0, 0),
    pyramid: pyramidSeeds,
    mergedCandidates: [{ chunkId: c1, score: 0.7 }]
  }, ctx);
  const out = await stage.process(v9, ctx);
  assert.strictEqual(out.tagMemoV10Skipped, true);
  assert.strictEqual(out.tagMemo.version, 'v9', 'v9 tag memo must be untouched');
});

test('TagMemoV10Stage: pruneByEnergy strips weak field entries', async () => {
  const stage = new TagMemoV10Stage();
  const { metaStore, c1 } = await seedTagMemoStore();
  const ctx = new PipelineContext({
    config: {
      tagMemoV10Enabled: true,
      pruneByEnergy: true,
      minFieldEnergy: 0.6,
      dimension: dim
    },
    metadataStore: metaStore,
    tagGraph: miniGraph9()
  });
  const v9 = await new TagMemoV9Stage().process({
    queryVector: vec(1, 0, 0, 0),
    pyramid: pyramidSeeds,
    mergedCandidates: [{ chunkId: c1, score: 0.7 }]
  }, ctx);
  const out = await stage.process(v9, ctx);
  assert.strictEqual(out.tagMemo.pruneSkipped, false);
  assert.ok(out.tagMemo.prunedFieldEntries >= 0);
});

// ── RiverMemoStage ─────────────────────────────────────────────────────────

class InMemoryKvStore {
  constructor() {
    this.rows = new Map();
  }
  async getKv(key) {
    return this.rows.has(key) ? this.rows.get(key) : null;
  }
  async setKv(key, value) {
    this.rows.set(key, value);
  }
}

function baseRiverInput() {
  return {
    tagMemo: {
      version: 'v9',
      riverGraph: {
        nodes: [{ id: 1 }, { id: 2 }, { id: 3 }],
        edges: [{ sourceId: 1, targetId: 2, flow: 0.2, minHop: 1, conductance: 0.8 }],
        diagnostics: { seedNodes: 1, reachedNodes: 3, activeEdges: 1 }
      }
    },
    mergedCandidates: [{ chunkId: 11, score: 0.6, tags: ['alpha'] }]
  };
}

function riverStep(store, config = {}) {
  return new PipelineContext({
    config: { riverMemoEnabled: true, riverDecay: 1.0, ...config },
    riverStateStore: store
  });
}

test('RiverMemoStage: river state persists across three ticks', async () => {
  const stage = new RiverMemoStage();
  assert.strictEqual(stage.name, 'riverMemo');

  const store = new InMemoryKvStore();
  const ctx = riverStep(store, { riverDecay: 1.0 });

  for (let tick = 1; tick <= 3; tick++) {
    const out = await stage.process(baseRiverInput(), ctx);
    assert.strictEqual(out.riverMemo.tick, tick, `tick ${tick} state must persist`);
  }

  const state = JSON.parse(await store.getKv('river_state'));
  assert.strictEqual(state.tick, 3);
  assert.ok(Math.abs(state.flows['1-2'].flow - 0.6) < 1e-9, 'flows accumulate across ticks');
});

test('RiverMemoStage: confluent branches merge into the target node', async () => {
  const stage = new RiverMemoStage();
  const store = new InMemoryKvStore();
  const ctx = riverStep(store);

  const first = baseRiverInput();
  await stage.process(first, ctx);

  const second = baseRiverInput();
  second.tagMemo.riverGraph.edges = [{
    sourceId: 3, targetId: 2, flow: 0.2, minHop: 1, conductance: 0.8
  }];
  const out = await stage.process(second, ctx);

  assert.ok(out.riverMemo.nodeTotals[2] >= 0.4,
    'both branches must flow into node 2 (converged)');
});

test('RiverMemoStage: regime controls the rerank formula', async () => {
  const stage = new RiverMemoStage();
  const store = new InMemoryKvStore();
  const ctx = riverStep(store);

  const collapsedInput = baseRiverInput();
  collapsedInput.tagMemo.riverGraph.edges = [];
  collapsedInput.tagMemo.riverGraph.nodes = [{ id: 1 }];
  collapsedInput.tagMemo.riverGraph.diagnostics = { seedNodes: 1, reachedNodes: 1, activeEdges: 0 };
  const collapsed = await stage.process(collapsedInput, ctx);
  assert.strictEqual(collapsed.riverMemo.regime, 'collapsed');
  assert.strictEqual(collapsed.mergedCandidates[0].score, 0.6,
    'collapsed regime keeps the base score');

  const sparse = await stage.process(baseRiverInput(), ctx);
  assert.ok(sparse.riverMemo.regime === 'sparse' || sparse.riverMemo.regime === 'dense');
});

test('RiverMemoStage: disabled is a passthrough', async () => {
  const stage = new RiverMemoStage();
  const store = new InMemoryKvStore();
  const ctx = new PipelineContext({
    config: { riverMemoEnabled: false },
    riverStateStore: store
  });
  const input = baseRiverInput();
  const out = await stage.process(input, ctx);
  assert.strictEqual(out.riverSkipped, true);
});

// ── Integration: candidate-merger → tagmemo v9 → tagmemo v10 ───────────────

test('integration: candidate-merger output feeds TagMemoV9 then TagMemoV10', async () => {
  const { metaStore, c1, c2 } = await seedTagMemoStore();
  const mergerCtx = new PipelineContext({ config: {} });
  const merged = await new CandidateMergerStage().process({
    vectorResults: [{ chunkId: c1, score: 0.9 }],
    bm25Results: [{ chunkId: c2, score: 0.4 }]
  }, mergerCtx);
  assert.strictEqual(merged.mergedCandidates.length, 2);

  const ctx = new PipelineContext({
    config: { tagMemoV9Enabled: true, tagMemoV10Enabled: true, dimension: dim },
    metadataStore: metaStore,
    tagGraph: miniGraph9()
  });
  const input = {
    queryVector: vec(1, 0, 0, 0),
    pyramid: pyramidSeeds,
    ...merged
  };
  const v9 = await new TagMemoV9Stage().process(input, ctx);
  assert.ok(v9.tagMemo && v9.tagMemo.activations.size >= 3);
  const v10 = await new TagMemoV10Stage().process(v9, ctx);
  assert.strictEqual(v10.tagMemo.version, 'v10');
  assert.ok(v10.mergedCandidates.length >= 1);
});