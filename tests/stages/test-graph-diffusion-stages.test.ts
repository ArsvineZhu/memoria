"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import PipelineContext from "../../src/core/context.js";
import SqliteMetadataStore from "../../src/providers/sqlite-metadata-store.js";
import { encodeVectorBlob } from "../../src/utils/vector-codec.js";
import CandidateMergerStage from "../../src/stages/retrieval/candidate-merger.js";

import {
  propagate,
  computeFirWeights,
} from "../../src/algorithms/tag-graph/activation-propagation.js";
import { computePropagationSpread } from "../../src/algorithms/tag-graph/propagation-spread.js";
import {
  buildRowOperator,
  solveGraphDiffusion,
} from "../../src/algorithms/tag-graph/graph-diffusion-solver.js";

import ActivationPropagationStage from "../../src/stages/tag-retrieval/activation-propagation.js";
import GraphDiffusionStage from "../../src/stages/tag-retrieval/graph-diffusion.js";
import PropagationHistoryStage from "../../src/stages/tag-retrieval/propagation-history.js";
import PropagationStructureStage from "../../src/stages/tag-retrieval/propagation-structure-reranker.js";
import type {
  MemoryConfigOverrides,
  PipelineData,
  PropagationHistoryObservation,
  PropagationHistorySnapshot,
  PropagationHistoryStore,
} from "../../src/types.js";

const dim = 4;

function vec(...components: number[]): Float32Array {
  return new Float32Array(components);
}

function adjacency(
  ...rows: Array<readonly [number, Record<string, number>]>
): Map<number, Map<number, number>> {
  const graph = new Map<number, Map<number, number>>();
  for (const [from, neighbors] of rows) {
    graph.set(
      Number(from),
      new Map(
        Object.entries(neighbors).map(([to, weight]) => [Number(to), Number(weight)]),
      ),
    );
  }
  return graph;
}

// ── activation propagation (pure algorithm) ────────────────────────────────

test("activation propagation: activations decay monotonically along a directed line", () => {
  const graph = adjacency([0, { 1: 1.0 }], [1, { 2: 1.0 }], [2, {}]);
  const result = propagate({
    sources: [{ id: 0, activation: 1 }],
    graph,
    config: {},
  });

  const activations = result.activations;
  assert.ok(activations instanceof Map, "activations must be a Map");
  const e0 = activations.get(0)!;
  const e1 = activations.get(1)!;
  const e2 = activations.get(2)!;
  assert.ok(
    e0 > e1 && e1 > e2 && e2 > 0,
    "activation must decay monotonically along the line",
  );
  assert.strictEqual(result.iterations, 2, "two rounds of propagation happened");

  // FIR-weighted readout: seed activation * normalized fir weight[0].
  const [w0, w1, w2] = computeFirWeights(0.6, 4);
  assert.ok(Math.abs(e0 - 1 * w0) < 1e-6, "seed activation = activation * fir[0]");
  assert.ok(
    Math.abs(e1 - 0.7 * w1) < 1e-6,
    "edge at shortcut threshold 1.0 is a shortcutEdge: decay 0.7",
  );
  assert.ok(
    Math.abs(e2 - 0.49 * w2) < 1e-6,
    "second hop continues the shortcutEdge decay",
  );
});

test("activation propagation: seed without neighbors still activates only the seed node", () => {
  const result = propagate({
    sources: [{ id: 0, activation: 1 }],
    config: {},
  });
  assert.strictEqual(result.activations.size, 1);
  const [w0] = computeFirWeights(0.6, 4);
  assert.ok(Math.abs(result.activations.get(0)! - w0!) < 1e-6);
  assert.strictEqual(
    result.iterations,
    0,
    "no reachable neighbors => no propagation rounds",
  );
});

test("activation propagation: zero hops leaves only seed activations", () => {
  const graph = adjacency([0, { 1: 1.0 }], [1, {}]);
  const result = propagate({
    sources: [{ id: 0, activation: 1 }],
    graph,
    config: { propagationMaxHops: 0 },
  });
  assert.strictEqual(result.activations.size, 1);
  assert.strictEqual(result.activations.get(1), undefined);
  assert.strictEqual(result.iterations, 0);
});

test("activation propagation: branching limit keeps only the strongest neighbors", () => {
  const graph = adjacency([0, { 1: 1.0, 2: 0.8, 3: 0.7 }], [1, {}], [2, {}], [3, {}]);
  const result = propagate({
    sources: [{ id: 0, activation: 1 }],
    graph,
    config: { maxNeighborsPerNode: 2, shortcutEdgeThreshold: 10 },
  });
  assert.ok(result.activations.has(1));
  assert.ok(result.activations.has(2));
  assert.strictEqual(
    result.activations.get(3),
    undefined,
    "weakest neighbor must not fire",
  );
});

test("activation propagation: shortcut edges keep routingBudget and reach further nodes", () => {
  const graph = adjacency([0, { 1: 1.0 }], [1, { 2: 1.0 }], [2, { 3: 1.0 }], [3, {}]);
  const without = propagate({
    sources: [{ id: 0, activation: 1 }],
    graph,
    config: { shortcutEdgeThreshold: 10 },
  });
  assert.strictEqual(
    without.activations.get(3),
    undefined,
    "ordinary edges exhaust routingBudget before the third hop",
  );

  const withShortcut = propagate({
    sources: [{ id: 0, activation: 1 }],
    graph,
    shortcutEdges: new Set(["1:2"]),
    config: { shortcutEdgeThreshold: 10 },
  });
  assert.ok(
    withShortcut.activations.get(3)! > 0,
    "a shortcutEdge edge lets the state bypass the routingBudget cost",
  );
});

test("activation propagation: pruneAbove drops weak activations relative to the peak", () => {
  const graph = adjacency([0, { 1: 0.5 }], [1, { 2: 0.5 }], [2, {}]);
  const result = propagate({
    sources: [{ id: 0, activation: 1 }],
    graph,
    config: { shortcutEdgeThreshold: 10, pruneAbove: 0.9 },
  });
  assert.ok(result.activations.get(0)! > 0);
  assert.strictEqual(
    result.activations.get(1),
    undefined,
    "weak node pruned below 90% of peak",
  );
  assert.ok(result.diagnostics.prunedNodeCount >= 1);
});

test("activation propagation: neighborFn callback replaces an inline graph", () => {
  const calls: number[] = [];
  const result = propagate({
    sources: [{ id: 7, activation: 1 }],
    neighborFn: (id) => {
      calls.push(id);
      if (id === 7) return new Map([[5, 0.5]]);
      return new Map();
    },
    config: { shortcutEdgeThreshold: 10 },
  });
  assert.deepStrictEqual(calls, [7, 5]);
  assert.ok(result.activations.has(5));
  const [, w1] = computeFirWeights(0.6, 4);
  assert.ok(
    Math.abs(result.activations.get(5)! - 0.5 * 0.25 * w1!) < 1e-6,
    "ordinary edge uses baseDecay 0.25",
  );
});

// ── propagation spread (pure tag association graph) ────────────────────────

test("computePropagationSpread: empty distribution collapses, rich distribution turns broad", () => {
  const inactive = computePropagationSpread({
    queryPropagationTrace: { diagnostics: {} },
  });
  assert.strictEqual(inactive.spreadClass, "inactive");
  assert.strictEqual(inactive.spreadScore, 0);

  const propagation = {
    diagnostics: { seedNodes: 2, reachedNodes: 8, activeEdges: 9 },
    nodes: [
      { id: 1, hop: 0 },
      { id: 2, hop: 0 },
      { id: 3, hop: 1 },
      { id: 4, hop: 1 },
      { id: 5, hop: 2 },
      { id: 6, hop: 2 },
      { id: 7, hop: 3 },
      { id: 8, hop: 3 },
      { id: 9, hop: 4 },
    ],
    edges: Array.from({ length: 9 }, () => ({ flow: 0.5 })),
  };
  const broad = computePropagationSpread({ queryPropagationTrace: propagation });
  assert.ok(broad.spreadScore > 0.4, "rich distribution should classify as broad");
  assert.strictEqual(broad.spreadClass, "broad");
});

// ── graph-diffusion distribution solver (pure tag association graph) ─────────────────────

test("solve dual graph-diffusion distributions converges on a line graph and derives domains", () => {
  const graph = adjacency(
    [1, { 2: 1 }],
    [2, { 1: 1, 3: 1 }],
    [3, { 2: 1, 4: 1 }],
    [4, { 3: 1 }],
  );
  const operator = buildRowOperator(graph);
  const solved = solveGraphDiffusion({
    localOperator: operator,
    transferOperator: operator,
    seedDistribution: [[4, 1]],
    local: { alpha: 0.15, maxIterations: 200, tolerance: 1e-9 },
    transfer: { alpha: 0.55, maxIterations: 200, tolerance: 1e-9 },
    support: {
      method: "mass_ratio",
      massRatio: 0.8,
      localSupportMassRatio: 0.8,
      extendedSupportMassRatio: 0.9,
    },
  });
  assert.strictEqual(solved.diagnostics.converged, true);
  assert.ok(solved.localSupport.ids.length >= 1, "local domain must be derived");
  assert.ok(solved.extendedSupport.ids.length >= 1, "transfer domain must be derived");
});

// ── ActivationPropagationStage ─────────────────────────────────────────────────────────

async function seedTagGraphPropagationStore() {
  const metaStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const f1 = (await metaStore.upsertFile({
    path: "a.md",
    space: "d",
    checksum: "a",
    sourceUpdatedAt: 1,
    size: 1,
  }))!;
  const f2 = (await metaStore.upsertFile({
    path: "b.md",
    space: "d",
    checksum: "b",
    sourceUpdatedAt: 1,
    size: 1,
  }))!;
  const [c1] = await metaStore.insertChunks(f1, [
    {
      chunkIndex: 0,
      content: "candidate a",
      vector: encodeVectorBlob(vec(1, 0, 0, 0)),
    },
  ]);
  const [c2] = await metaStore.insertChunks(f2, [
    {
      chunkIndex: 0,
      content: "candidate b",
      vector: encodeVectorBlob(vec(0, 1, 0, 0)),
    },
  ]);
  const [t1, t2, t3] = await metaStore.upsertTags([
    { name: "alpha", vector: encodeVectorBlob(vec(1, 0, 0, 0)) },
    { name: "beta", vector: encodeVectorBlob(vec(0, 1, 0, 0)) },
    { name: "gamma", vector: encodeVectorBlob(vec(0, 0, 1, 0)) },
  ]);
  await metaStore.setFileTags(f1, [t1, t2]);
  await metaStore.setFileTags(f2, [t2, t3]);
  return { metaStore, t1, t2, t3, c1, c2 };
}

function miniGraph9() {
  return adjacency(
    [1, { 2: 1.5, 3: 1.0 }],
    [2, { 1: 1.5, 3: 4.0 }],
    [3, { 1: 1.0, 2: 4.0 }],
  );
}

const tagResidualDecompositionSeeds = {
  levels: [{ level: 0, tags: [{ id: 1, name: "alpha", contribution: 0.5 }] }],
  features: {
    coverage: 0.2,
    novelty: 0.5,
    coherence: 0.3,
    propagationReadiness: 0.5,
    depth: 1,
  },
};

test("ActivationPropagationStage: activates the tag association graph and emits the activation distribution", async () => {
  const stage = new ActivationPropagationStage();
  assert.strictEqual(stage.name, "activationPropagation");

  const { metaStore, c1 } = await seedTagGraphPropagationStore();
  const ctx = new PipelineContext({
    config: { tagGraphPropagationEnabled: true, dimension: dim },
    metadataStore: metaStore,
    tagAssociationGraph: miniGraph9(),
  });
  const input = {
    queryVector: vec(1, 0, 0, 0),
    tagResidualDecomposition: tagResidualDecompositionSeeds,
    mergedCandidates: [{ chunkId: c1, score: 0.7 }],
  };

  const out = await stage.process(input, ctx);
  assert.ok(out.tagGraphPropagation, "tagGraphPropagation must be attached");
  assert.strictEqual(
    out.tagGraphPropagation.schema,
    "tag-graph-activation-propagation-v1",
  );
  assert.ok(
    out.tagGraphPropagation.activations instanceof Map,
    "activations must be a Map",
  );
  assert.ok(
    out.tagGraphPropagation!.activations!.size >= 3,
    "derived nodes must join the seeds",
  );
  assert.ok(
    out.tagGraphPropagation!.activations!.get(1)! > 0,
    "seed node activation must be positive",
  );

  assert.ok(
    Array.isArray(out.tagGraphPropagation!.ranked),
    "ranked must be a sorted list",
  );
  assert.strictEqual(
    out.tagGraphPropagation!.ranked![0].id,
    1,
    "seed should lead by activation",
  );
  assert.strictEqual(
    out.tagGraphPropagation!.ranked![0].name,
    "alpha",
    "names should be resolved",
  );

  assert.ok(out.tagGraphPropagation!.iterations! >= 0);
  assert.ok(
    out.tagGraphPropagation!.propagationTrace,
    "propagation graph must be attached",
  );
  assert.ok(Array.isArray(out.tagGraphPropagation!.propagationTrace!.nodes));
  assert.ok(Array.isArray(out.tagGraphPropagation!.propagationTrace!.edges));
});

test("ActivationPropagationStage: deterministic across identical runs", async () => {
  const stage = new ActivationPropagationStage();
  const { metaStore, c1 } = await seedTagGraphPropagationStore();
  const cx = () =>
    new PipelineContext({
      config: { tagGraphPropagationEnabled: true, dimension: dim },
      metadataStore: metaStore,
      tagAssociationGraph: miniGraph9(),
    });
  const input = () => ({
    queryVector: vec(1, 0, 0, 0),
    tagResidualDecomposition: tagResidualDecompositionSeeds,
    mergedCandidates: [{ chunkId: c1, score: 0.7 }],
  });

  const a = await stage.process(input(), cx());
  const b = await stage.process(input(), cx());
  assert.deepStrictEqual(
    [...a.tagGraphPropagation!.activations!],
    [...b.tagGraphPropagation!.activations!],
    "activations must be identical",
  );
  assert.deepStrictEqual(
    a.tagGraphPropagation!.propagationTrace,
    b.tagGraphPropagation!.propagationTrace,
  );
});

test("ActivationPropagationStage: disabled by config is a passthrough", async () => {
  const stage = new ActivationPropagationStage();
  const { metaStore, c1 } = await seedTagGraphPropagationStore();
  const ctx = new PipelineContext({
    config: { tagGraphPropagationEnabled: false },
    metadataStore: metaStore,
    tagAssociationGraph: miniGraph9(),
  });
  const input = {
    queryVector: vec(1, 0, 0, 0),
    mergedCandidates: [{ chunkId: c1, score: 0.7 }],
  };
  const out = await stage.process(input, ctx);
  assert.strictEqual(out.tagGraphPropagationSkipped, true);
  assert.deepStrictEqual(out.mergedCandidates, input.mergedCandidates);
});

test("ActivationPropagationStage: falls back to candidate tags when no tagResidualDecomposition is present", async () => {
  const stage = new ActivationPropagationStage();
  const { metaStore, c1 } = await seedTagGraphPropagationStore();
  const ctx = new PipelineContext({
    config: { tagGraphPropagationEnabled: true },
    metadataStore: metaStore,
    tagAssociationGraph: miniGraph9(),
  });
  const out = await stage.process(
    {
      queryVector: vec(1, 0, 0, 0),
      mergedCandidates: [{ chunkId: c1, score: 0.7, tags: ["alpha"] }],
    },
    ctx,
  );
  assert.ok(
    out.tagGraphPropagation,
    "candidate seed path must produce activation output",
  );
  assert.ok(
    out.tagGraphPropagation!.activations!.get(1)! > 0,
    "alpha should be activated from candidate tags",
  );
});

test("ActivationPropagationStage: no graph and no seeds short-circuits with a skip flag", async () => {
  const stage = new ActivationPropagationStage();
  const ctx = new PipelineContext({
    config: { tagGraphPropagationEnabled: true },
    metadataStore: null,
  });
  const out = await stage.process(
    {
      queryVector: vec(1, 0, 0, 0),
      mergedCandidates: [],
    },
    ctx,
  );
  assert.strictEqual(out.tagGraphPropagationSkipped, true);
});

test("ActivationPropagationStage projects canonical propagation config to the TS kernel", () => {
  const projected = new ActivationPropagationStage()._propagateConfig({
    routingBudget: 11,
    standardEdgePropagationFactor: 0.31,
    shortcutEdgePropagationFactor: 0.83,
    minimumInjectedActivation: 0.0007,
  });

  assert.deepEqual(projected, {
    routingBudget: 11,
    standardEdgePropagationFactor: 0.31,
    shortcutEdgePropagationFactor: 0.83,
    minimumInjectedActivation: 0.0007,
  });
});

// ── GraphDiffusionStage ────────────────────────────────────────────────────────

test("GraphDiffusionStage: solves dual graph-diffusion distributions over activation output", async () => {
  const stage = new GraphDiffusionStage();
  assert.strictEqual(stage.name, "graphDiffusion");

  const { metaStore, c1 } = await seedTagGraphPropagationStore();
  const ctx = new PipelineContext({
    config: {
      tagGraphPropagationEnabled: true,
      dimension: dim,
    },
    metadataStore: metaStore,
    tagAssociationGraph: miniGraph9(),
  });

  const activationOutput = await new ActivationPropagationStage().process(
    {
      queryVector: vec(1, 0, 0, 0),
      tagResidualDecomposition: tagResidualDecompositionSeeds,
      mergedCandidates: [{ chunkId: c1, score: 0.7, tags: ["alpha", "beta"] }],
    },
    ctx,
  );

  const out = await stage.process(activationOutput, ctx);
  assert.ok(out.tagGraphPropagation, "tagGraphPropagation must be attached");
  assert.strictEqual(out.tagGraphPropagation.schema, "tag-graph-diffusion-v1");
  assert.ok(
    Array.isArray(out.tagGraphPropagation.seedDistribution) &&
      out.tagGraphPropagation.seedDistribution.length > 0,
  );
  assert.ok(Array.isArray(out.tagGraphPropagation.localDistribution));
  assert.ok(Array.isArray(out.tagGraphPropagation.extendedDistribution));
  assert.ok(out.tagGraphPropagation!.localSupport!.ids.length >= 0);
  assert.ok(out.tagGraphPropagation!.extendedSupport!.ids.length >= 0);
  assert.strictEqual(out.tagGraphPropagation!.solverDiagnostics!.converged, true);
  assert.ok(
    out.tagGraphPropagation!.ranked!.length >= 1,
    "ranked list from the diffusion distribution readout",
  );
  assert.ok(Number.isFinite(out.tagGraphPropagation!.seedDistribution![0][0]));
});

test("GraphDiffusionStage uses the extended diffusion tolerance for transfer convergence", async () => {
  const { metaStore, c1 } = await seedTagGraphPropagationStore();
  const ctx = new PipelineContext({
    config: {
      tagGraphPropagationEnabled: true,
      dimension: dim,
      diffusionMaxIterations: 1,
      localDiffusionTolerance: 1,
      extendedDiffusionTolerance: 1e-15,
    },
    metadataStore: metaStore,
    tagAssociationGraph: miniGraph9(),
  });
  const activationOutput = await new ActivationPropagationStage().process(
    {
      queryVector: vec(1, 0, 0, 0),
      tagResidualDecomposition: tagResidualDecompositionSeeds,
      mergedCandidates: [{ chunkId: c1, score: 0.7 }],
    },
    ctx,
  );
  const out = await new GraphDiffusionStage().process(activationOutput, ctx);

  assert.equal(out.tagGraphPropagation?.solverDiagnostics?.localConverged, true);
  assert.equal(
    out.tagGraphPropagation?.solverDiagnostics?.transferConverged,
    false,
    "a strict extended tolerance must not be replaced by the local tolerance",
  );
});

test("GraphDiffusionStage reranks candidates with domain overlap boost", async () => {
  const stage = new GraphDiffusionStage();
  const { metaStore, c1 } = await seedTagGraphPropagationStore();
  const ctx = new PipelineContext({
    config: { tagGraphPropagationEnabled: true, dimension: dim },
    metadataStore: metaStore,
    tagAssociationGraph: miniGraph9(),
  });
  const activationOutput = await new ActivationPropagationStage().process(
    {
      queryVector: vec(1, 0, 0, 0),
      tagResidualDecomposition: tagResidualDecompositionSeeds,
      mergedCandidates: [{ chunkId: c1, score: 0.7, tags: ["alpha", "beta"] }],
    },
    ctx,
  );
  const out = await stage.process(activationOutput, ctx);
  assert.ok(
    out.mergedCandidates!.length >= 1,
    "candidates survive diffusion reranking",
  );
  const candidate = out.mergedCandidates![0];
  assert.ok(
    "propagationBonus" in candidate,
    "candidate should carry the propagation bonus",
  );
  assert.ok(candidate.propagationBonus! >= 0);
});

test("GraphDiffusionStage: disabled is a passthrough that keeps activation output", async () => {
  const stage = new GraphDiffusionStage();
  const { metaStore, c1 } = await seedTagGraphPropagationStore();
  const ctx = new PipelineContext({
    config: { tagGraphPropagationEnabled: false },
    metadataStore: metaStore,
    tagAssociationGraph: miniGraph9(),
  });
  const out = await stage.process(
    {
      tagGraphPropagation: {
        schema: "tag-graph-activation-propagation-v1",
        activations: new Map([[1, 1]]),
      },
      mergedCandidates: [{ chunkId: c1, score: 0.7 }],
    },
    ctx,
  );
  assert.strictEqual(out.graphDiffusionSkipped, true);
  assert.strictEqual(
    out.tagGraphPropagation!.schema,
    "tag-graph-activation-propagation-v1",
    "activation output must be untouched",
  );
});

test("GraphDiffusionStage keeps the full solved distribution without legacy pruning", async () => {
  const stage = new GraphDiffusionStage();
  const { metaStore, c1 } = await seedTagGraphPropagationStore();
  const ctx = new PipelineContext({
    config: {
      tagGraphPropagationEnabled: true,
      supportSelectionMethod: "mass_ratio",
      dimension: dim,
    },
    metadataStore: metaStore,
    tagAssociationGraph: miniGraph9(),
  });
  const activationOutput = await new ActivationPropagationStage().process(
    {
      queryVector: vec(1, 0, 0, 0),
      tagResidualDecomposition: tagResidualDecompositionSeeds,
      mergedCandidates: [{ chunkId: c1, score: 0.7 }],
    },
    ctx,
  );
  const out = await stage.process(activationOutput, ctx);
  assert.strictEqual(out.tagGraphPropagation!.pruneSkipped, true);
  assert.strictEqual(out.tagGraphPropagation!.prunedDistributionEntries, 0);
});

// ── PropagationHistoryStage and PropagationStructureRerankerStage ─────────────

class InMemoryPropagationHistoryStore implements PropagationHistoryStore {
  sequence = 0;
  totalMass = 0;
  edgeTotals = new Map<string, number>();
  readError: Error | null = null;

  async readPropagationHistory(
    nodeIds: readonly number[],
  ): Promise<PropagationHistorySnapshot> {
    if (this.readError) throw this.readError;
    const ids = new Set(nodeIds);
    return {
      sequence: this.sequence,
      totalMass: this.totalMass,
      edgeTotals: [...this.edgeTotals].filter(([key]) => {
        const [source, target] = key.split(":").map(Number);
        return ids.has(source) || ids.has(target);
      }),
    };
  }

  async commitPropagationObservation(
    observation: PropagationHistoryObservation,
  ): Promise<PropagationHistorySnapshot> {
    this.sequence += 1;
    for (const edge of observation.edges) {
      this.edgeTotals.set(
        `${edge.sourceId}:${edge.targetId}`,
        (this.edgeTotals.get(`${edge.sourceId}:${edge.targetId}`) || 0) +
          edge.increment,
      );
      this.totalMass += edge.increment;
    }
    return this.readPropagationHistory(observation.nodeIds);
  }
}

function basePropagationInput(): PipelineData {
  return {
    tagGraphPropagation: {
      schema: "tag-graph-activation-propagation-v1",
      propagationTrace: {
        nodes: [{ id: 1 }, { id: 2 }, { id: 3 }],
        edges: [
          { sourceId: 1, targetId: 2, flow: 0.2, minHop: 1, associationWeight: 0.8 },
        ],
        diagnostics: { seedNodes: 1, reachedNodes: 3, activeEdges: 1 },
      },
    },
    mergedCandidates: [{ chunkId: 11, score: 0.6, tags: ["alpha"] }],
  };
}

function propagationContext(
  store: InMemoryPropagationHistoryStore,
  config: MemoryConfigOverrides = {},
) {
  return new PipelineContext({
    config: { propagationHistoryEnabled: true, historyUpdateScale: 1.0, ...config },
    propagationHistoryStore: store,
  });
}

test("PropagationHistoryStage computes an observation without mutating history", async () => {
  const stage = new PropagationHistoryStage();
  assert.strictEqual(stage.name, "propagationHistory");

  const store = new InMemoryPropagationHistoryStore();
  const ctx = propagationContext(store, { historyUpdateScale: 1.0 });

  const out = await stage.process(basePropagationInput(), ctx);
  assert.strictEqual(out.propagationHistory!.sequence, 1);
  assert.ok(out.propagationHistoryObservation);
  assert.equal(store.sequence, 0);
  assert.equal(store.edgeTotals.size, 0);

  await store.commitPropagationObservation(out.propagationHistoryObservation!);
  await store.commitPropagationObservation(out.propagationHistoryObservation!);
  await store.commitPropagationObservation(out.propagationHistoryObservation!);

  const state = await store.readPropagationHistory([1, 2]);
  assert.strictEqual(store.sequence, 3);
  assert.ok(
    Math.abs(state.edgeTotals.find(([key]) => key === "1:2")![1] - 0.6) < 1e-9,
    "edge totals accumulate across sequences",
  );
});

test("PropagationHistoryStage preserves an explicit zero update scale", async () => {
  const out = await new PropagationHistoryStage().process(
    basePropagationInput(),
    propagationContext(new InMemoryPropagationHistoryStore(), {
      historyUpdateScale: 0,
    }),
  );

  assert.equal(out.propagationHistory?.tickFlowMass, 0);
  assert.deepEqual(out.propagationHistoryObservation?.edges, []);
});

test("PropagationHistoryStage merges convergent branches into target support", async () => {
  const stage = new PropagationHistoryStage();
  const store = new InMemoryPropagationHistoryStore();
  const ctx = propagationContext(store);

  const first = basePropagationInput();
  const firstOut = await stage.process(first, ctx);
  await store.commitPropagationObservation(firstOut.propagationHistoryObservation!);

  const second = basePropagationInput();
  second.tagGraphPropagation!.propagationTrace!.edges = [
    {
      sourceId: 3,
      targetId: 2,
      flow: 0.2,
      minHop: 1,
      associationWeight: 0.8,
    },
  ];
  const out = await stage.process(second, ctx);
  await store.commitPropagationObservation(out.propagationHistoryObservation!);

  assert.ok(
    out.propagationHistory!.nodeTotals!["2"] >= 0.4,
    "both branches must flow into node 2",
  );
});

test("PropagationStructureRerankerStage uses canonical spread distributions", async () => {
  const stage = new PropagationStructureStage();
  assert.strictEqual(stage.name, "propagationStructureReranker");
  const store = new InMemoryPropagationHistoryStore();
  const ctx = new PipelineContext({
    config: { propagationStructureRerankEnabled: true },
    propagationHistoryStore: store,
  });

  const inactiveInput = basePropagationInput();
  inactiveInput.tagGraphPropagation!.propagationTrace!.edges = [];
  inactiveInput.tagGraphPropagation!.propagationTrace!.nodes = [{ id: 1 }];
  inactiveInput.tagGraphPropagation!.propagationTrace!.diagnostics = {
    seedNodes: 1,
    reachedNodes: 1,
    activeEdges: 0,
  };
  const inactive = await stage.process(inactiveInput, ctx);
  assert.strictEqual(inactive.propagationStructure!.spreadClass, "inactive");
  assert.strictEqual(
    inactive.mergedCandidates![0].score,
    0.6,
    "inactive spread keeps the base score",
  );

  const sparse = await stage.process(basePropagationInput(), ctx);
  assert.ok(
    sparse.propagationStructure!.spreadClass === "sparse" ||
      sparse.propagationStructure!.spreadClass === "broad",
  );
});

test("PropagationStructureStage: disabled is a passthrough", async () => {
  const stage = new PropagationStructureStage();
  const store = new InMemoryPropagationHistoryStore();
  const ctx = new PipelineContext({
    config: { propagationStructureRerankEnabled: false },
    propagationHistoryStore: store,
  });
  const input = basePropagationInput();
  const out = await stage.process(input, ctx);
  assert.strictEqual(out.propagationStructureSkipped, true);
});

test("activation observation survives diffusion for history and structure consumers", async () => {
  const { metaStore, c1 } = await seedTagGraphPropagationStore();
  const activationContext = new PipelineContext({
    config: { tagGraphPropagationEnabled: true, dimension: dim },
    metadataStore: metaStore,
    tagAssociationGraph: miniGraph9(),
  });
  const activationOutput = await new ActivationPropagationStage().process(
    {
      queryVector: vec(1, 0, 0, 0),
      tagResidualDecomposition: tagResidualDecompositionSeeds,
      mergedCandidates: [{ chunkId: c1, score: 0.7, tags: ["alpha"] }],
    },
    activationContext,
  );
  const diffusionOutput = await new GraphDiffusionStage().process(
    activationOutput,
    activationContext,
  );

  const trace = diffusionOutput.tagGraphPropagation?.propagationTrace;
  assert.ok(trace, "diffusion must retain the activation propagation trace");
  assert.ok(
    Array.isArray(trace.edges) && trace.edges.length > 0,
    "diffusion must retain activation edges for downstream consumers",
  );
  const observedTrace = (
    diffusionOutput.tagRetrievalObservation as
      { propagation?: { propagationTrace?: { edges?: unknown[] } } } | undefined
  )?.propagation?.propagationTrace;
  assert.ok(
    Array.isArray(observedTrace?.edges) && observedTrace.edges.length > 0,
    "canonical observation must retain activation edges",
  );

  const history = new InMemoryPropagationHistoryStore();
  const historyOutput = await new PropagationHistoryStage().process(
    diffusionOutput,
    propagationContext(history),
  );
  assert.ok(
    (historyOutput.propagationHistoryObservation?.edges.length || 0) > 0,
    "history must observe the preserved activation edges",
  );

  const structureOutput = await new PropagationStructureStage().process(
    diffusionOutput,
    new PipelineContext({ config: { propagationStructureRerankEnabled: true } }),
  );
  assert.notEqual(
    structureOutput.propagationStructure?.spreadClass,
    "inactive",
    "structure scoring must see the preserved activation graph",
  );
  assert.ok(
    Number(structureOutput.propagationStructure?.activeEdges || 0) > 0,
    "structure scoring must count activation edges",
  );
});

test("PropagationHistoryStage never overwrites history after a read failure", async () => {
  const stage = new PropagationHistoryStage();
  const store = new InMemoryPropagationHistoryStore();
  store.sequence = 7;
  store.edgeTotals.set("1:2", 4);
  store.totalMass = 4;
  store.readError = new Error("temporary history read failure");

  await assert.rejects(
    () => stage.process(basePropagationInput(), propagationContext(store)),
    /temporary history read failure/,
  );
  assert.equal(store.sequence, 7);
  assert.equal(store.edgeTotals.get("1:2"), 4);
});

// ── Integration: candidate merger → activation propagation → graph diffusion ─

test("integration: candidate-merger output feeds ActivationPropagation then GraphDiffusion", async () => {
  const { metaStore, c1, c2 } = await seedTagGraphPropagationStore();
  const mergerCtx = new PipelineContext({ config: {} });
  const merged = await new CandidateMergerStage().process(
    {
      vectorResults: [{ chunkId: c1, score: 0.9 }],
      bm25Results: [{ chunkId: c2, score: 0.4 }],
    },
    mergerCtx,
  );
  assert.strictEqual(merged.mergedCandidates.length, 2);

  const ctx = new PipelineContext({
    config: { tagGraphPropagationEnabled: true, dimension: dim },
    metadataStore: metaStore,
    tagAssociationGraph: miniGraph9(),
  });
  const input = {
    queryVector: vec(1, 0, 0, 0),
    tagResidualDecomposition: tagResidualDecompositionSeeds,
    ...merged,
  };
  const activationOutput = await new ActivationPropagationStage().process(input, ctx);
  assert.ok(
    activationOutput.tagGraphPropagation &&
      activationOutput.tagGraphPropagation.activations!.size >= 3,
  );
  const diffusionOutput = await new GraphDiffusionStage().process(
    activationOutput,
    ctx,
  );
  assert.strictEqual(
    diffusionOutput.tagGraphPropagation!.schema,
    "tag-graph-diffusion-v1",
  );
  assert.ok(diffusionOutput.mergedCandidates!.length >= 1);
});
