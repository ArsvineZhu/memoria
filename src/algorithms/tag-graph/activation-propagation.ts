import type { UnknownRecord } from "../../types.js";
import { at } from "../../utils/numerical.js";

type NeighborInput =
  | Map<number, number>
  | readonly (readonly unknown[] | UnknownRecord)[]
  | UnknownRecord
  | undefined;
type EdgeInput = readonly unknown[] | UnknownRecord;

export interface ActivationSeedInput {
  id: number;
  activation?: number;
  isCore?: boolean;
  name?: string | null;
}

export interface ActivationSeed {
  id: number;
  activation: number;
  isCore?: boolean;
  name: string | null;
}

export interface ActivationConfig extends UnknownRecord {
  propagationMaxHops?: number;
  baseRoutingBudget?: number;
  routingBudget?: number;
  activationThreshold?: number;
  baseDecay?: number;
  shortcutDecay?: number;
  shortcutEdgeThreshold?: number;
  maxNeighborsPerNode?: number;
  branchLimit?: number;
  returnFlowFactor?: number;
  returnActivationFactor?: number;
  firGamma?: number;
  hopReadoutGamma?: number;
  maxPropagationStates?: number;
  pruneAbove?: number;
}

export interface ActivationOptions {
  sources?: readonly ActivationSeedInput[];
  source?: readonly ActivationSeedInput[];
  graph?: Map<number, Map<number, number>>;
  edges?: readonly EdgeInput[];
  neighborFn?: (nodeId: number) => NeighborInput;
  residuals?: Map<number, number> | UnknownRecord;
  shortcutEdges?: ReadonlySet<string>;
  config?: ActivationConfig;
}

interface ActivationState {
  nodeId: number;
  previousNodeId: number | null;
  activation: number;
  routingBudget: number;
  sourceType: string;
  hop: number;
}

interface PropagationProvenance {
  sourceType: string;
  originType?: string;
  hop: number;
  seedId?: number;
}

interface PropagationEdge {
  sourceId: number;
  targetId: number;
  flow: number;
  maxFlow: number;
  associationWeight: number;
  minHop: number;
  shortcutEdge: boolean;
  immediateReturn: boolean;
}

interface ParentRecord {
  parentId: number;
  flow: number;
  hop: number;
  shortcutEdge: boolean;
}

export interface ActivationDiagnostics extends UnknownRecord {
  algorithmVersion: string;
  returnFlowSuppressedMass: number;
  stateTruncations: number;
  hopInFlightMass: number[];
  prunedNodeCount: number;
  seedNodes: number;
  reachedNodes: number;
  activeEdges: number;
}

/**
 * Pure tag-association-graph activation propagation (state / LIF routing) algorithm.
 *
 * Activation states travel the tag association graph,
 * decaying by hop, gated by routingBudget and activation threshold, with optional
 * shortcut edges that bypass the routing-budget cost. Node activations
 * are accumulated with a hop-weighted FIR (finite impulse response) readout.
 *
 * The engine fed the propagation kernel (directed co-occurrence matrix) and
 * residual values from its own stores; here the graph is injected as a
 * pure adjacency: a Map<nodeId, Map<neighborId, weight>>, an edges array,
 * or a `neighborFn` callback. Residual anchors and shortcut edges
 * edge sets are optional injected estimators with zero I/O.
 */

const ALGORITHM_VERSION = "tag-graph-activation-propagation";
const PROPAGATION_HISTORY_SCHEMA = "tag-graph-propagation-v1";

function clamp01(value: unknown): number {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function fin(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function integer(value: unknown, fallback: number): number {
  const numeric = fin(value, fallback);
  return Math.max(0, Math.floor(numeric));
}

function mapValue(
  source: Map<number, number> | UnknownRecord | undefined,
  key: number,
): unknown {
  if (!source) return undefined;
  if (source instanceof Map) return source.get(key);
  const result = source[String(key)];
  return result === undefined ? null : result;
}

/**
 * FIR tap weights normalized to unit sum (used by the accumulated-activation
 * readout). `gamma` is clamped to [0.05, 0.95] like the engine.
 *
 * @param {number} gamma
 * @param {number} propagationMaxHops
 * @returns {number[]}
 */
function computeFirWeights(gamma: number, propagationMaxHops: number): number[] {
  const clampedGamma = Math.max(0.05, Math.min(0.95, fin(gamma, 0.6)));
  const taps = Math.max(0, integer(propagationMaxHops, 4));
  const weights = [];
  let sum = 0;
  for (let hop = 0; hop <= taps; hop++) {
    const weight = Math.pow(clampedGamma, hop);
    weights.push(weight);
    sum += weight;
  }
  if (sum > 0) {
    for (let hop = 0; hop < weights.length; hop++) {
      weights[hop] = at(weights, hop, "FIR weights") / sum;
    }
  }
  return weights;
}

function sourceEntries(sources: unknown): ActivationSeed[] {
  const entries: ActivationSeed[] = [];
  if (Array.isArray(sources)) {
    for (const rawValue of sources as readonly unknown[]) {
      const raw = rawValue as Partial<ActivationSeedInput> | null;
      if (!raw) continue;
      const id = Number(raw.id);
      if (!Number.isFinite(id)) continue;
      entries.push({
        id,
        activation: Math.max(0, fin(raw.activation, 1)),
        isCore: raw.isCore === true,
        name: raw.name || null,
      });
    }
  }
  return entries;
}

function neighborMap(neighbors: NeighborInput): Map<number, number> {
  const result = new Map<number, number>();
  if (neighbors instanceof Map) {
    for (const [id, weight] of neighbors.entries()) {
      const numericId = Number(id);
      const numericWeight = Number(weight);
      if (Number.isFinite(numericId) && Number.isFinite(numericWeight)) {
        result.set(numericId, numericWeight);
      }
    }
    return result;
  }
  if (Array.isArray(neighbors)) {
    for (const entry of neighbors as readonly (readonly unknown[] | UnknownRecord)[]) {
      const row = Array.isArray(entry) ? entry : null;
      const objectEntry =
        !row && entry && typeof entry === "object" ? (entry as UnknownRecord) : null;
      const id = entry != null ? Number(objectEntry?.id ?? row?.[0]) : NaN;
      const weight = entry != null ? Number(objectEntry?.weight ?? row?.[1]) : NaN;
      if (Number.isFinite(id) && Number.isFinite(weight)) {
        result.set(id, weight);
      }
    }
    return result;
  }
  if (neighbors && typeof neighbors === "object") {
    for (const [id, weight] of Object.entries(neighbors)) {
      const numericId = Number(id);
      const numericWeight = Number(weight);
      if (Number.isFinite(numericId) && Number.isFinite(numericWeight)) {
        result.set(numericId, numericWeight);
      }
    }
  }
  return result;
}

/**
 * Build an adjacency Map<nodeId, Map<neighborId, weight>> from an edges
 * array of [from, to, weight] triples (also accepts objects).
 *
 * @param {Array} edges
 * @returns {Map<number, Map<number, number>>}
 */
function adjacencyFromEdges(
  edges: readonly EdgeInput[] | undefined,
): Map<number, Map<number, number>> {
  const adjacency = new Map<number, Map<number, number>>();
  for (const edge of edges || []) {
    let fromId = NaN;
    let toId = NaN;
    let weight = NaN;
    if (Array.isArray(edge)) {
      fromId = Number(edge[0]);
      toId = Number(edge[1]);
      weight = Number(edge[2]);
    } else if (edge && typeof edge === "object") {
      const objectEdge = edge as UnknownRecord;
      fromId = Number(objectEdge.from ?? objectEdge.sourceId ?? objectEdge.source);
      toId = Number(objectEdge.to ?? objectEdge.targetId ?? objectEdge.target);
      weight = Number(objectEdge.weight ?? objectEdge.flow);
    }
    if (
      !Number.isFinite(fromId) ||
      !Number.isFinite(toId) ||
      !Number.isFinite(weight) ||
      weight <= 0
    )
      continue;
    if (!adjacency.has(fromId)) adjacency.set(fromId, new Map());
    const row = adjacency.get(fromId);
    if (!row) continue;
    row.set(toId, (row.get(toId) || 0) + weight);
  }
  return adjacency;
}

/**
 * Resolve the neighbour lookup for a node: an explicit neighborFn wins,
 * otherwise the injected graph Map is used.
 *
 * @param {number} nodeId
 * @param {Map<number, Map<number, number>>|undefined} graph
 * @param {function} [neighborFn]
 * @returns {Map<number, number>|undefined}
 */
function neighborsOf(
  nodeId: number,
  graph: Map<number, Map<number, number>> | undefined,
  neighborFn: ((nodeId: number) => NeighborInput) | undefined,
): Map<number, number> | undefined {
  if (typeof neighborFn === "function") {
    const raw = neighborFn(nodeId);
    return raw == null ? undefined : neighborMap(raw);
  }
  return graph ? graph.get(nodeId) || undefined : undefined;
}

/**
 * Pure state-propagation over a tag co-occurrence graph.
 *
 * @param {object} options
 * @param {Array<{id:number, activation?:number, isCore?:boolean, name?:string}>} [options.sources] - initial tags
 * @param {Map<number, Map<number, number>>} [options.graph] - adjacency
 * @param {Array} [options.edges] - [from, to, weight] triples when no graph
 * @param {function(number): (Map|Array|object|undefined)} [options.neighborFn] - injected neighbor lookup
 * @param {Map<number, number>|object} [options.residuals] - per-node residual values
 * @param {Set<string>} [options.shortcutEdges] - 'from:to' shortcut edges
 * @param {object} [options.config]
 * @returns {{ activations: Map, propagationProvenance: Map, propagationTrace: object,
 *            iterations: number, diagnostics: object }}
 */
export interface ActivationPropagationResult {
  activations: Map<number, number>;
  propagationProvenance: Map<number, PropagationProvenance>;
  propagationTrace: UnknownRecord;
  iterations: number;
  diagnostics: ActivationDiagnostics;
}

function propagate(options: ActivationOptions = {}): ActivationPropagationResult {
  const config = options.config || {};
  const propagationMaxHops = integer(config.propagationMaxHops ?? 4, 4);
  const baseRoutingBudget = Math.max(
    0,
    fin(config.baseRoutingBudget ?? config.routingBudget ?? 2.0, 2.0),
  );
  const activationThreshold = Math.max(0, fin(config.activationThreshold ?? 0.1, 0.1));
  const baseDecay = Math.max(0, fin(config.baseDecay ?? 0.25, 0.25));
  const shortcutDecay = Math.max(0, fin(config.shortcutDecay ?? 0.7, 0.7));
  const shortcutEdgeThreshold = Math.max(
    0,
    fin(config.shortcutEdgeThreshold ?? 1.0, 1.0),
  );
  const maxNeighborsPerNode = integer(
    config.maxNeighborsPerNode ?? config.branchLimit ?? 20,
    20,
  );
  const returnFlowFactor = clamp01(
    config.returnFlowFactor ?? config.returnActivationFactor ?? 0.15,
  );
  const firGamma = clamp01(config.firGamma ?? config.hopReadoutGamma ?? 0.6);
  const maxPropagationStates = Math.max(
    100,
    integer(config.maxPropagationStates ?? config.maxPropagationStates ?? 2000, 2000),
  );
  // pruneAbove: drop activations below this ratio of the peak after readout.
  const pruneAbove = clamp01(config.pruneAbove ?? 0);
  const graph =
    options.graph instanceof Map ? options.graph : adjacencyFromEdges(options.edges);

  const firWeights = computeFirWeights(firGamma, propagationMaxHops);

  const sources = sourceEntries(options.sources ?? options.source);
  const activeStates = new Map<string, ActivationState>();
  const accumulatedActivation = new Map<number, number>();
  const propagationProvenance = new Map<number, PropagationProvenance>();
  const propagationEdgeFlow = new Map<string, PropagationEdge>();
  const strongestParentByNode = new Map<number, ParentRecord>();

  for (const tag of sources) {
    const key = `seed:${tag.id}`;
    const sourceType = tag.isCore ? "core" : "seed";
    activeStates.set(key, {
      nodeId: tag.id,
      previousNodeId: null,
      activation: tag.activation,
      routingBudget: baseRoutingBudget,
      sourceType,
      hop: 0,
    });
    accumulatedActivation.set(
      tag.id,
      tag.activation * at(firWeights, 0, "FIR weights"),
    );
    propagationProvenance.set(tag.id, {
      sourceType,
      hop: 0,
      seedId: tag.id,
    });
  }

  const diagnostics: {
    algorithmVersion: string;
    returnFlowSuppressedMass: number;
    stateTruncations: number;
    hopInFlightMass: number[];
    prunedNodeCount: number;
    [key: string]: unknown;
  } = {
    algorithmVersion: ALGORITHM_VERSION,
    returnFlowSuppressedMass: 0,
    stateTruncations: 0,
    hopInFlightMass: [],
    prunedNodeCount: 0,
  };

  let iterations = 0;
  let currentStates = activeStates;

  for (let hop = 0; hop < propagationMaxHops; hop++) {
    const nextStates = new Map<string, ActivationState>();
    let propagated = false;
    let inFlightMass = 0;

    for (const state of currentStates.values()) {
      if (state.activation < activationThreshold || state.routingBudget < 0) continue;
      const synapses = neighborsOf(state.nodeId, graph, options.neighborFn);
      if (!synapses) continue;

      const sortedSynapses = [...synapses.entries()]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, maxNeighborsPerNode);

      for (const [neighborId, coocWeight] of sortedSynapses) {
        const neighborResidual = mapValue(options.residuals, neighborId);
        const effectiveNeighborResidual =
          neighborResidual == null ? 1.0 : Math.max(0, Number(neighborResidual) || 0);
        const shortcutSignal = coocWeight * effectiveNeighborResidual;
        const isShortcut =
          options.shortcutEdges instanceof Set
            ? options.shortcutEdges.has(`${state.nodeId}:${neighborId}`)
            : shortcutSignal >= shortcutEdgeThreshold;
        const decayFactor = isShortcut ? shortcutDecay : baseDecay;
        const routingCost = isShortcut ? 0 : 1.0;
        const isImmediateReturn =
          state.previousNodeId !== null && neighborId === state.previousNodeId;
        const flowFactor = isImmediateReturn ? returnFlowFactor : 1;
        const unpenalizedCurrent = state.activation * coocWeight * decayFactor;
        const injectedCurrent = unpenalizedCurrent * flowFactor;
        if (isImmediateReturn) {
          diagnostics.returnFlowSuppressedMass += unpenalizedCurrent - injectedCurrent;
        }
        if (injectedCurrent < 0.01) continue;

        const sourceId = Number(state.nodeId);
        const targetId = Number(neighborId);
        const edgeKey = `${sourceId}:${targetId}`;
        const previousEdge = propagationEdgeFlow.get(edgeKey);
        if (previousEdge) {
          previousEdge.flow += injectedCurrent;
          previousEdge.maxFlow = Math.max(previousEdge.maxFlow, injectedCurrent);
          previousEdge.minHop = Math.min(previousEdge.minHop, state.hop + 1);
        } else {
          propagationEdgeFlow.set(edgeKey, {
            sourceId,
            targetId,
            flow: injectedCurrent,
            maxFlow: injectedCurrent,
            associationWeight: Math.max(0, Number(coocWeight) || 0),
            minHop: state.hop + 1,
            shortcutEdge: isShortcut,
            immediateReturn: isImmediateReturn,
          });
        }

        const previousParent = strongestParentByNode.get(targetId);
        if (
          !previousParent ||
          injectedCurrent > previousParent.flow ||
          (injectedCurrent === previousParent.flow &&
            state.hop + 1 < previousParent.hop)
        ) {
          strongestParentByNode.set(targetId, {
            parentId: sourceId,
            flow: injectedCurrent,
            hop: state.hop + 1,
            shortcutEdge: isShortcut,
          });
        }

        const nextRoutingBudget = state.routingBudget - routingCost;
        if (nextRoutingBudget < 0 && !isShortcut) continue;

        const stateKey = `${state.nodeId}:${neighborId}`;
        const existing = nextStates.get(stateKey);
        if (existing) {
          existing.activation += injectedCurrent;
          existing.routingBudget = Math.max(existing.routingBudget, nextRoutingBudget);
          if (state.hop + 1 < existing.hop) {
            existing.hop = state.hop + 1;
            existing.sourceType = state.sourceType;
          }
        } else {
          nextStates.set(stateKey, {
            nodeId: neighborId,
            previousNodeId: state.nodeId,
            activation: injectedCurrent,
            routingBudget: nextRoutingBudget,
            sourceType: state.sourceType,
            hop: state.hop + 1,
          });
        }
      }
    }

    if (nextStates.size > maxPropagationStates) {
      const retained = [...nextStates.entries()]
        .sort((a, b) => b[1].activation - a[1].activation)
        .slice(0, maxPropagationStates);
      diagnostics.stateTruncations += nextStates.size - retained.length;
      nextStates.clear();
      for (const [key, value] of retained) nextStates.set(key, value);
    }

    const nodeActivationThisHop = new Map<number, number>();
    for (const newState of nextStates.values()) {
      nodeActivationThisHop.set(
        newState.nodeId,
        (nodeActivationThisHop.get(newState.nodeId) || 0) + newState.activation,
      );
      const numericNodeId = Number(newState.nodeId);
      const previousProvenance = propagationProvenance.get(numericNodeId);
      if (!previousProvenance || newState.hop < previousProvenance.hop) {
        propagationProvenance.set(numericNodeId, {
          sourceType: "derived",
          originType: newState.sourceType,
          hop: newState.hop,
        });
      }
      inFlightMass += newState.activation;
    }
    diagnostics.hopInFlightMass.push(inFlightMass);

    const activationWeight = at(
      firWeights,
      Math.min(hop + 1, firWeights.length - 1),
      "FIR weights",
    );
    for (const [nodeId, activation] of nodeActivationThisHop.entries()) {
      accumulatedActivation.set(
        nodeId,
        (accumulatedActivation.get(nodeId) || 0) + activation * activationWeight,
      );
      if (activation > 0.01) propagated = true;
    }

    if (!propagated) break;
    iterations += 1;
    currentStates = nextStates;
  }

  // Optional readout pruning relative to the peak activation.
  let prunedNodeCount = 0;
  const readoutKeys = [...accumulatedActivation.keys()];
  const peakActivation = readoutKeys.reduce(
    (max, id) => Math.max(max, accumulatedActivation.get(id) || 0),
    0,
  );
  if (pruneAbove > 0 && peakActivation > 0) {
    for (const id of readoutKeys) {
      if ((accumulatedActivation.get(id) || 0) < pruneAbove * peakActivation) {
        accumulatedActivation.delete(id);
        propagationProvenance.delete(id);
        prunedNodeCount += 1;
      }
    }
  }
  diagnostics.prunedNodeCount = prunedNodeCount;

  const maximumNodeActivation = Math.max(0, ...accumulatedActivation.values());
  const maximumEdgeFlow = Math.max(
    0,
    ...[...propagationEdgeFlow.values()].map((edge) => edge.flow),
  );
  const propagationTrace = {
    schema: PROPAGATION_HISTORY_SCHEMA,
    nodes: [...accumulatedActivation.entries()]
      .map(([rawId, rawActivation]) => {
        const id = Number(rawId);
        const provenance = propagationProvenance.get(id) || {
          sourceType: "unknown",
          hop: Number.POSITIVE_INFINITY,
        };
        const parent = strongestParentByNode.get(id) || null;
        return {
          id,
          activation: Math.max(0, Number(rawActivation) || 0),
          normalizedActivation:
            maximumNodeActivation > 0
              ? Math.max(0, Number(rawActivation) || 0) / maximumNodeActivation
              : 0,
          sourceType: provenance.sourceType || "unknown",
          originType: provenance.originType || null,
          hop: Number.isFinite(provenance.hop) ? provenance.hop : null,
          seedId: Number.isFinite(provenance.seedId) ? provenance.seedId : null,
          strongestParent: parent ? { ...parent } : null,
        };
      })
      .sort((left, right) => right.activation - left.activation || left.id - right.id),
    edges: [...propagationEdgeFlow.values()]
      .map((edge) => ({
        ...edge,
        normalizedFlow: maximumEdgeFlow > 0 ? edge.flow / maximumEdgeFlow : 0,
      }))
      .sort(
        (left, right) =>
          right.flow - left.flow ||
          left.sourceId - right.sourceId ||
          left.targetId - right.targetId,
      ),
    diagnostics: {
      seedNodes: sources.length,
      reachedNodes: accumulatedActivation.size,
      activeEdges: propagationEdgeFlow.size,
      maximumNodeActivation,
      maximumEdgeFlow,
    },
  };

  return {
    activations: accumulatedActivation,
    propagationProvenance,
    propagationTrace,
    iterations,
    diagnostics: {
      ...diagnostics,
      seedNodes: sources.length,
      reachedNodes: accumulatedActivation.size,
      activeEdges: propagationEdgeFlow.size,
    },
  };
}

export {
  ALGORITHM_VERSION,
  PROPAGATION_HISTORY_SCHEMA,
  computeFirWeights,
  adjacencyFromEdges,
  propagate,
};
