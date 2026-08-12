import type { UnknownRecord } from "../../types/common.js";
import type { PropagationSpreadResult } from "../../types/retrieval.js";

interface PropagationNode extends UnknownRecord {
  hop?: number;
}
interface PropagationEdge extends UnknownRecord {
  flow?: number;
}
interface PropagationTrace {
  diagnostics?: UnknownRecord;
  nodes?: readonly PropagationNode[];
  edges?: readonly PropagationEdge[];
  queryPropagationTrace?: PropagationTrace;
}
interface ObservabilityOptions extends UnknownRecord {
  kappaEdge?: number;
  kappaRatio?: number;
  epsilon?: number;
  spreadEpsilon?: number;
  inactiveThreshold?: number;
  sparseThreshold?: number;
  completeObservation?: boolean;
}

/**
 * Propagation spread classification — pure tag association graph observation.
 *
 * Given the query-side propagation graph (nodes, edges, diagnostics), classify
 * whether the query formed a rich propagation distribution ("broad"), a thin one
 * ("sparse") or inactive to the seeds ("inactive"), via the geometric mean
 * of edge-ratio, derived-node-ratio and flow-entropy sub-observables.
 */

const SCHEMA = "tag-propagation-spread-v1";

function clamp01(value: unknown): number {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function finitePositive(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizedFlowEntropy(edges: readonly PropagationEdge[]): number {
  const positiveFlows = edges
    .map((edge) => Math.max(0, Number(edge?.flow) || 0))
    .filter((flow) => flow > 0);

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
 * @param {object} propagationTrace - { diagnostics, nodes, edges }
 * @param {object} [options]
 * @param {number} [options.kappaEdge=0.5]  - active-edge budget per seed
 * @param {number} [options.kappaRatio=0.3] - derivation ratio budget
 * @param {number} [options.epsilon=0.02]  - geometric floor
 * @param {number} [options.inactiveThreshold=0.12]
 * @param {number} [options.sparseThreshold=0.45]
 * @param {boolean} [options.completeObservation]
 * @returns {Readonly<object>}
 */
function computePropagationSpread(
  propagationTrace: PropagationTrace | null | undefined,
  options: ObservabilityOptions = {},
): Readonly<PropagationSpreadResult> {
  const kappaEdge = finitePositive(options.kappaEdge, 0.5);
  const kappaRatio = finitePositive(options.kappaRatio, 0.3);
  const epsilon = Math.max(
    Number.EPSILON,
    Math.min(1, finitePositive(options.epsilon ?? options.spreadEpsilon, 0.02)),
  );
  const inactiveThreshold = clamp01(options.inactiveThreshold ?? 0.12);
  const sparseThreshold = Math.max(
    inactiveThreshold,
    clamp01(options.sparseThreshold ?? 0.45),
  );

  const propagation: PropagationTrace =
    propagationTrace && propagationTrace.queryPropagationTrace
      ? propagationTrace.queryPropagationTrace
      : propagationTrace || {};
  const propagationDiagnostics = propagation.diagnostics || {};
  const edges = Array.isArray(propagation.edges) ? propagation.edges : [];
  const nodes = Array.isArray(propagation.nodes) ? propagation.nodes : [];

  const activeEdges = Math.max(
    0,
    Number.isFinite(Number(propagationDiagnostics.activeEdges))
      ? Number(propagationDiagnostics.activeEdges)
      : edges.length,
  );
  const seedNodes = Math.max(
    0,
    Number.isFinite(Number(propagationDiagnostics.seedNodes))
      ? Number(propagationDiagnostics.seedNodes)
      : nodes.filter((node) => Number(node?.hop) === 0).length,
  );
  const reachedNodes = Math.max(
    0,
    Number.isFinite(Number(propagationDiagnostics.reachedNodes))
      ? Number(propagationDiagnostics.reachedNodes)
      : nodes.length,
  );

  const safeSeedNodes = Math.max(1, seedNodes);
  const edgeCoverage = clamp01(activeEdges / (kappaEdge * safeSeedNodes));
  const derivedNodes = Math.max(0, reachedNodes - seedNodes);
  const derivedCoverage = clamp01(derivedNodes / (kappaRatio * safeSeedNodes));
  const flowEntropy = normalizedFlowEntropy(edges);
  // An empty propagation distribution has zero mass in every sub-observable:
  // resolve to exactly zero while retaining the epsilon floor for near-zero distributions.
  const completeObservation = options.completeObservation === true;
  const observationFactor = completeObservation ? 1 : 0.5;
  let spreadScore = 0;
  if (edgeCoverage > 0 || derivedCoverage > 0 || flowEntropy > 0) {
    const geometricScore = Math.cbrt(
      Math.max(edgeCoverage, epsilon) *
        Math.max(derivedCoverage, epsilon) *
        Math.max(flowEntropy, epsilon),
    );
    spreadScore = clamp01(geometricScore * observationFactor);
  }
  const spreadClass =
    spreadScore < inactiveThreshold
      ? "inactive"
      : spreadScore < sparseThreshold
        ? "sparse"
        : "broad";

  return Object.freeze({
    schema: SCHEMA,
    spreadScore,
    edgeCoverage,
    derivedCoverage,
    flowEntropy,
    activeEdges,
    seedNodes,
    reachedNodes,
    derivedNodes,
    edgeFlowEntropy: flowEntropy,
    completeObservation,
    observationFactor,
    spreadClass,
    parameters: Object.freeze({
      kappaEdge,
      kappaRatio,
      epsilon,
      inactiveThreshold,
      sparseThreshold,
    }),
  });
}

export { SCHEMA, normalizedFlowEntropy, computePropagationSpread };
