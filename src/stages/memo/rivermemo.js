'use strict';

const Stage = require('../../core/stage');
const { computeRiverObservability } =
  require('../../algorithms/topology/river-observability');

const RIVER_STATE_KEY = 'river_state';
const RIVER_SCHEMA = 'tagmemo-rivermemo-state-v1';

/**
 * RiverMemoStage — persistent river-flow accumulation and regime reranking.
 *
 * Faithful port of RiverMemoEngine's river state machine: every processed
 * query spike river contributes its edge flows into a persistent river state
 * (stored in ctx.riverStateStore under {RIVER_STATE_KEY}); flows accumulate
 * across ticks and per-target-node totals drive the candidate rerank. The
 * river observability functional (modules/tagmemoV10/riverObservability)
 * classifies the current query river into collapsed / sparse / dense:
 * only a non-collapsed regime re-scores candidates with a small topology
 * bonus so a fold river never inflates the base semantic score.
 *
 * Config (ctx.config):
 *   - riverMemoEnabled   gate (default false)
 *   - riverDecay         flow decay per tick (default 1.0)
 *   - riverTopologyCap   rerank bonus cap (default 0.08)
 * Context (ctx):
 *   - ctx.riverStateStore  KV store with getKv/setKv
 *
 * Output: { ..., riverMemo: { tick, regime, flows, nodeTotals, diagnostics },
 *          mergedCandidates: reranked } or riverSkipped: true.
 */
class RiverMemoStage extends Stage {
  constructor() {
    super();
    this.name = 'riverMemo';
  }

  async process(input, ctx) {
    const info = input || {};
    const config = ctx.config || {};

    if (!config.riverMemoEnabled) {
      return { ...info, riverSkipped: true };
    }

    const riverGraph = info.tagMemo && info.tagMemo.riverGraph
      ? info.tagMemo.riverGraph
      : { nodes: [], edges: [], diagnostics: {} };
    const store = ctx.riverStateStore;
    if (!store || typeof store.getKv !== 'function'
      || typeof store.setKv !== 'function') {
      return { ...info, riverSkipped: true };
    }

    const state = await this._loadState(store);
    const tick = (Number(state.tick) || 0) + 1;
    const riverDecay = Math.max(0, Number(config.riverDecay) || 1.0);
    const flows = state.flows;

    const nodeTotals = new Map();
    for (const [key, flowRow] of flows.entries()) {
      const targetId = Number(flowRow && flowRow.targetId);
      if (Number.isFinite(targetId)) {
        nodeTotals.set(targetId, (nodeTotals.get(targetId) || 0)
          + (Number(flowRow.flow) || 0));
      }
    }

    let tickFlowMass = 0;
    let activeEdges = 0;

    for (const edge of riverGraph.edges || []) {
      const sourceId = Number(edge && edge.sourceId);
      const targetId = Number(edge && edge.targetId);
      const rawFlow = Number(edge && edge.flow) || 0;
      if (!Number.isFinite(sourceId) || !Number.isFinite(targetId) || rawFlow <= 0) {
        continue;
      }
      const key = `${sourceId}-${targetId}`;
      const increment = rawFlow * riverDecay;
      const previous = flows.get(key) || {
        sourceId,
        targetId,
        flow: 0,
        conductance: Math.max(0, Number(edge && edge.conductance) || 0),
        firstTick: tick,
        lastTick: tick
      };
      previous.flow += increment;
      previous.lastTick = tick;
      flows.set(key, previous);
      nodeTotals.set(targetId, (nodeTotals.get(targetId) || 0) + increment);
      tickFlowMass += increment;
      activeEdges += 1;
    }

    const observability = computeRiverObservability({
      nodes: riverGraph.nodes,
      edges: riverGraph.edges,
      diagnostics: riverGraph.diagnostics || {}
    });
    const regime = String(observability.regime || 'collapsed');

    const reranked = this._rerank(
      info.mergedCandidates,
      regime,
      nodeTotals,
      config
    );

    const persisted = {
      schema: RIVER_SCHEMA,
      tick,
      flows: Object.fromEntries(
        [...flows.entries()].sort((left, right) => left[0].localeCompare(right[0]))
      )
    };
    await store.setKv(RIVER_STATE_KEY, JSON.stringify(persisted));

    return {
      ...info,
      riverMemo: {
        tick,
        schema: RIVER_SCHEMA,
        regime,
        omega: observability.omega,
        flows: persisted.flows,
        nodeTotals: Object.fromEntries(
          [...nodeTotals.entries()].sort((left, right) => left[0] - right[0])
        ),
        tickFlowMass,
        activeEdges,
        observability,
        rerankedCount: reranked.length
      },
      mergedCandidates: reranked
    };
  }

  async _loadState(store) {
    let raw = null;
    try {
      raw = await store.getKv(RIVER_STATE_KEY);
    } catch (e) {
      raw = null;
    }
    if (!raw) return { tick: 0, flows: new Map() };
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const flows = new Map(
        Object.entries(parsed.flows || {})
          .map(([key, value]) => [key, { ...(value || {}) }])
      );
      return { tick: Number(parsed.tick) || 0, flows };
    } catch (e) {
      return { tick: 0, flows: new Map() };
    }
  }

  _rerank(candidates, regime, nodeTotals, config) {
    const source = Array.isArray(candidates) ? candidates : [];
    if (source.length === 0) return source;

    const collapsed = regime === 'collapsed';
    const cap = Math.max(0, Number(config.riverTopologyCap) || 0.08);
    const results = [];
    for (const candidate of source) {
      const tagIds = Array.isArray(candidate && candidate.tags)
        ? candidate.tags.map(Number).filter(Number.isFinite)
        : [];
      let flowHit = 0;
      for (const id of tagIds) {
        flowHit = Math.max(flowHit, Number(nodeTotals.get(id)) || 0);
      }
      const score = collapsed
        ? (Number(candidate.score) || 0)
        : Math.max(0, Math.min(1,
          (Number(candidate.score) || 0)
          + Math.min(cap, cap * Math.min(1, flowHit))
        ));
      results.push({ ...candidate, score, flowHit, riverRegime: regime });
    }
    results.sort((left, right) =>
      (right.score - left.score) || (left.chunkId - right.chunkId)
    );
    return results;
  }
}

module.exports = RiverMemoStage;