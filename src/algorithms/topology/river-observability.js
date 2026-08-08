'use strict';

/**
 * River observability (Ω functional) — pure topology classification.
 *
 * Faithful port of modules/tagmemoV10/riverObservability.computeRiverObservability:
 * given the query-side spike river graph (nodes, edges, diagnostics), classify
 * whether the query formed a rich propagation river ("dense"), a thin one
 * ("sparse") or collapsed to the seeds ("collapsed"), via the geometric mean
 * of edge-ratio, emergence-ratio and flow-entropy sub-observables.
 */

const SCHEMA = 'tagmemo-v10-river-observability-v1';

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function finitePositive(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizedFlowEntropy(edges) {
  const positiveFlows = edges
    .map(edge => Math.max(0, Number(edge?.flow) || 0))
    .filter(flow => flow > 0);

  if (positiveFlows.length === 0) return 0;
  if (positiveFlows.length === 1) return 0.5;

  const totalFlow = positiveFlows.reduce((sum, flow) => sum + flow, 0);
  if (totalFlow <= 0) return 0;

  let entropy = 0;
  for (const flow of positiveFlows) {
    const probability = flow / totalFlow;
    entropy -= probability * Math.log(probability);
  }

  return clamp01(entropy / Math.log(positiveFlows.length));
}

/**
 * @param {object} riverGraph - { diagnostics, nodes, edges }
 * @param {object} [options]
 * @param {number} [options.kappaEdge=0.5]  - active-edge budget per seed
 * @param {number} [options.kappaRatio=0.3] - emergence ratio budget
 * @param {number} [options.epsilon=0.02]  - geometric floor
 * @param {number} [options.collapsedThreshold=0.12]
 * @param {number} [options.sparseThreshold=0.45]
 * @param {boolean} [options.completeObservation]
 * @returns {Readonly<object>}
 */
function computeRiverObservability(riverGraph, options = {}) {
  const kappaEdge = finitePositive(options.kappaEdge, 0.5);
  const kappaRatio = finitePositive(options.kappaRatio, 0.3);
  const epsilon = Math.max(
    Number.EPSILON,
    Math.min(1, finitePositive(options.epsilon ?? options.omegaEpsilon, 0.02))
  );
  const collapsedThreshold = clamp01(
    options.collapsedThreshold
    ?? options.structRoleMinOmega
    ?? 0.12
  );
  const sparseThreshold = Math.max(
    collapsedThreshold,
    clamp01(options.sparseThreshold ?? 0.45)
  );

  const river = riverGraph && riverGraph.queryRiverGraph
    ? riverGraph.queryRiverGraph
    : (riverGraph || {});
  const riverDiagnostics = river.diagnostics || {};
  const edges = Array.isArray(river.edges) ? river.edges : [];
  const nodes = Array.isArray(river.nodes) ? river.nodes : [];

  const activeEdges = Math.max(
    0,
    Number.isFinite(Number(riverDiagnostics.activeEdges))
      ? Number(riverDiagnostics.activeEdges)
      : edges.length
  );
  const seedNodes = Math.max(
    0,
    Number.isFinite(Number(riverDiagnostics.seedNodes))
      ? Number(riverDiagnostics.seedNodes)
      : nodes.filter(node => Number(node?.hop) === 0).length
  );
  const reachedNodes = Math.max(
    0,
    Number.isFinite(Number(riverDiagnostics.reachedNodes))
      ? Number(riverDiagnostics.reachedNodes)
      : nodes.length
  );

  const safeSeedNodes = Math.max(1, seedNodes);
  const omegaEdge = clamp01(activeEdges / (kappaEdge * safeSeedNodes));
  const emergentNodes = Math.max(0, reachedNodes - seedNodes);
  const omegaEmerge = clamp01(emergentNodes / (kappaRatio * safeSeedNodes));
  const omegaFlow = normalizedFlowEntropy(edges);
  // An empty river has zero mass in every sub-observable: resolve to exactly
  // zero (the epsilon floor only avoids division noise for near-zero rivers).
  const completeObservation = options.completeObservation === true;
  const observationFactor = completeObservation ? 1 : 0.5;
  let omega = 0;
  if (omegaEdge > 0 || omegaEmerge > 0 || omegaFlow > 0) {
    const geometricOmega = Math.cbrt(
      Math.max(omegaEdge, epsilon)
      * Math.max(omegaEmerge, epsilon)
      * Math.max(omegaFlow, epsilon)
    );
    omega = clamp01(geometricOmega * observationFactor);
  }
  const regime = omega < collapsedThreshold
    ? 'collapsed'
    : omega < sparseThreshold
      ? 'sparse'
      : 'dense';

  return Object.freeze({
    schema: SCHEMA,
    omega,
    omegaEdge,
    omegaEmerge,
    omegaFlow,
    activeEdges,
    seedNodes,
    reachedNodes,
    emergentNodes,
    edgeFlowEntropy: omegaFlow,
    completeObservation,
    observationFactor,
    regime,
    parameters: Object.freeze({
      kappaEdge,
      kappaRatio,
      epsilon,
      collapsedThreshold,
      sparseThreshold
    })
  });
}

module.exports = {
  SCHEMA,
  normalizedFlowEntropy,
  computeRiverObservability
};