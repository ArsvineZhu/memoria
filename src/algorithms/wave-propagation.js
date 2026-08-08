'use strict';

/**
 * Pure TagMemo wave-propagation (spike / LIF routing) algorithm.
 *
 * Faithful port of TagMemoEngine._propagateSpikes (v9.1 soft non-backtracking
 * FIR readout): activation spikes travel the tag co-occurrence graph,
 * decaying by hop, gated by momentum and firing threshold, with optional
 * wormhole edges (resonance) that bypass the momentum cost. Node energies
 * are accumulated with a hop-weighted FIR (finite impulse response) readout.
 *
 * The engine fed the propagation kernel (directed co-occurrence matrix) and
 * intrinsic residuals from its own stores; here the graph is injected as a
 * pure adjacency: a Map<nodeId, Map<neighborId, weight>>, an edges array,
 * or a `neighborFn` callback. Residuals (tension anchors) and wormhole
 * edge sets are optional injected estimators with zero I/O.
 */

const ALGORITHM_VERSION = 'tagmemo.wave-propagation-v9.1.soft-nonbacktracking-fir';
const RIVER_SCHEMA = 'tagmemo-query-spike-river-v1';

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function fin(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function integer(value, fallback) {
  const numeric = fin(value, fallback);
  return Math.max(0, Math.floor(numeric));
}

function mapValue(source, key) {
  if (!source) return undefined;
  if (source instanceof Map) return source.get(key);
  const result = source[key];
  return result === undefined ? null : result;
}

/**
 * FIR tap weights normalized to unit sum (used by the accumulated-energy
 * readout). `gamma` is clamped to [0.05, 0.95] like the engine.
 *
 * @param {number} gamma
 * @param {number} maxSafeHops
 * @returns {number[]}
 */
function computeFirWeights(gamma, maxSafeHops) {
  const clampedGamma = Math.max(0.05, Math.min(0.95, fin(gamma, 0.6)));
  const taps = Math.max(0, integer(maxSafeHops, 4));
  const weights = [];
  let sum = 0;
  for (let hop = 0; hop <= taps; hop++) {
    const weight = Math.pow(clampedGamma, hop);
    weights.push(weight);
    sum += weight;
  }
  if (sum > 0) {
    for (let hop = 0; hop < weights.length; hop++) weights[hop] /= sum;
  }
  return weights;
}

function sourceEntries(sources) {
  const entries = [];
  if (Array.isArray(sources)) {
    for (const raw of sources) {
      if (!raw) continue;
      const id = Number(raw.id);
      if (!Number.isFinite(id)) continue;
      entries.push({
        id,
        energy: Math.max(0, fin(raw.energy, 1)),
        isCore: raw.isCore === true,
        name: raw.name || null
      });
    }
  }
  return entries;
}

function neighborMap(neighbors) {
  const result = new Map();
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
    for (const entry of neighbors) {
      const id = entry != null ? Number(entry.id ?? entry[0]) : NaN;
      const weight = entry != null ? Number(entry.weight ?? entry[1]) : NaN;
      if (Number.isFinite(id) && Number.isFinite(weight)) {
        result.set(id, weight);
      }
    }
    return result;
  }
  if (neighbors && typeof neighbors === 'object') {
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
function adjacencyFromEdges(edges) {
  const adjacency = new Map();
  for (const edge of edges || []) {
    let fromId;
    let toId;
    let weight = NaN;
    if (Array.isArray(edge)) {
      fromId = Number(edge[0]);
      toId = Number(edge[1]);
      weight = Number(edge[2]);
    } else if (edge && typeof edge === 'object') {
      fromId = Number(edge.from ?? edge.sourceId ?? edge.source ?? edge[0]);
      toId = Number(edge.to ?? edge.targetId ?? edge.target ?? edge[1]);
      weight = Number(edge.weight ?? edge.flow ?? edge[2]);
    }
    if (
      !Number.isFinite(fromId)
      || !Number.isFinite(toId)
      || !Number.isFinite(weight)
      || weight <= 0
    ) continue;
    if (!adjacency.has(fromId)) adjacency.set(fromId, new Map());
    const row = adjacency.get(fromId);
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
function neighborsOf(nodeId, graph, neighborFn) {
  if (typeof neighborFn === 'function') {
    const raw = neighborFn(nodeId);
    return raw == null ? undefined : neighborMap(raw);
  }
  return graph ? graph.get(nodeId) || undefined : undefined;
}

/**
 * Pure spike-propagation over a tag co-occurrence graph.
 *
 * @param {object} options
 * @param {Array<{id:number, energy?:number, isCore?:boolean, name?:string}>} [options.sources] - initial tags
 * @param {Map<number, Map<number, number>>} [options.graph] - adjacency
 * @param {Array} [options.edges] - [from, to, weight] triples when no graph
 * @param {function(number): (Map|Array|object|undefined)} [options.neighborFn] - injected neighbor lookup
 * @param {Map<number, number>|object} [options.residuals] - per-node intrinsic residuals (tension anchors)
 * @param {Set<string>} [options.wormholeEdges] - 'from:to' resonance edges
 * @param {object} [options.config]
 * @returns {{ activations: Map, fieldProvenance: Map, riverGraph: object,
 *            iterations: number, diagnostics: object }}
 */
function propagate(options = {}) {
  const config = options.config || {};
  const maxSafeHops = integer(config.maxSafeHops ?? 4, 4);
  const baseMomentum = Math.max(0, fin(config.baseMomentum ?? config.momentum ?? 2.0, 2.0));
  const firingThreshold = Math.max(0, fin(config.firingThreshold ?? 0.10, 0.10));
  const baseDecay = Math.max(0, fin(config.baseDecay ?? 0.25, 0.25));
  const wormholeDecay = Math.max(0, fin(config.wormholeDecay ?? 0.70, 0.70));
  const tensionThreshold = Math.max(0, fin(config.tensionThreshold ?? 1.0, 1.0));
  const maxNeighborsPerNode = integer(
    config.maxNeighborsPerNode ?? config.branchLimit ?? 20,
    20
  );
  const returnFlowFactor = clamp01(
    config.returnFlowFactor ?? config.v91ReturnFlowFactor ?? 0.15
  );
  const firGamma = clamp01(config.firGamma ?? config.v91FirGamma ?? 0.6);
  const maxPropagationStates = Math.max(
    100,
    integer(config.maxPropagationStates ?? config.stateLimit ?? 2000, 2000)
  );
  // pruneAbove: drop activations below this ratio of the peak after readout.
  const pruneAbove = clamp01(config.pruneAbove ?? 0);
  const graph = options.graph instanceof Map
    ? options.graph
    : adjacencyFromEdges(options.edges);

  const firWeights = computeFirWeights(firGamma, maxSafeHops);

  const sources = sourceEntries(options.sources ?? options.source);
  const activeSpikes = new Map();
  const accumulatedEnergy = new Map();
  const fieldProvenance = new Map();
  const riverEdgeFlow = new Map();
  const strongestParentByNode = new Map();

  for (const tag of sources) {
    const key = `seed:${tag.id}`;
    const sourceType = tag.isCore ? 'core' : 'seed';
    activeSpikes.set(key, {
      nodeId: tag.id,
      previousNodeId: null,
      energy: tag.energy,
      momentum: baseMomentum,
      sourceType,
      hop: 0
    });
    accumulatedEnergy.set(tag.id, tag.energy * firWeights[0]);
    fieldProvenance.set(tag.id, {
      sourceType,
      hop: 0,
      seedId: tag.id
    });
  }

  const diagnostics = {
    algorithmVersion: ALGORITHM_VERSION,
    returnFlowSuppressedMass: 0,
    stateTruncations: 0,
    hopInFlightMass: []
  };

  let iterations = 0;
  let currentSpikes = activeSpikes;

  for (let hop = 0; hop < maxSafeHops; hop++) {
    const nextSpikes = new Map();
    let propagated = false;
    let inFlightMass = 0;

    for (const spike of currentSpikes.values()) {
      if (spike.energy < firingThreshold || spike.momentum < 0) continue;
      const synapses = neighborsOf(spike.nodeId, graph, options.neighborFn);
      if (!synapses) continue;

      const sortedSynapses = [...synapses.entries()]
        .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
        .slice(0, maxNeighborsPerNode);

      for (const [neighborId, coocWeight] of sortedSynapses) {
        const neighborResidual = mapValue(options.residuals, neighborId);
        const effectiveNeighborResidual = neighborResidual == null
          ? 1.0
          : Math.max(0, Number(neighborResidual) || 0);
        const tension = coocWeight * effectiveNeighborResidual;
        const isWormhole = options.wormholeEdges instanceof Set
          ? options.wormholeEdges.has(`${spike.nodeId}:${neighborId}`)
          : tension >= tensionThreshold;
        const decayFactor = isWormhole ? wormholeDecay : baseDecay;
        const momentumCost = isWormhole ? 0 : 1.0;
        const isImmediateReturn = spike.previousNodeId !== null
          && neighborId === spike.previousNodeId;
        const flowFactor = isImmediateReturn ? returnFlowFactor : 1;
        const unpenalizedCurrent = spike.energy * coocWeight * decayFactor;
        const injectedCurrent = unpenalizedCurrent * flowFactor;
        if (isImmediateReturn) {
          diagnostics.returnFlowSuppressedMass += unpenalizedCurrent - injectedCurrent;
        }
        if (injectedCurrent < 0.01) continue;

        const sourceId = Number(spike.nodeId);
        const targetId = Number(neighborId);
        const edgeKey = `${sourceId}:${targetId}`;
        const previousEdge = riverEdgeFlow.get(edgeKey);
        if (previousEdge) {
          previousEdge.flow += injectedCurrent;
          previousEdge.maxFlow = Math.max(previousEdge.maxFlow, injectedCurrent);
          previousEdge.minHop = Math.min(previousEdge.minHop, spike.hop + 1);
        } else {
          riverEdgeFlow.set(edgeKey, {
            sourceId,
            targetId,
            flow: injectedCurrent,
            maxFlow: injectedCurrent,
            conductance: Math.max(0, Number(coocWeight) || 0),
            minHop: spike.hop + 1,
            wormhole: isWormhole,
            immediateReturn: isImmediateReturn
          });
        }

        const previousParent = strongestParentByNode.get(targetId);
        if (
          !previousParent
          || injectedCurrent > previousParent.flow
          || (injectedCurrent === previousParent.flow
            && spike.hop + 1 < previousParent.hop)
        ) {
          strongestParentByNode.set(targetId, {
            parentId: sourceId,
            flow: injectedCurrent,
            hop: spike.hop + 1,
            wormhole: isWormhole
          });
        }

        const nextMomentum = spike.momentum - momentumCost;
        if (nextMomentum < 0 && !isWormhole) continue;

        const stateKey = `${spike.nodeId}:${neighborId}`;
        const existing = nextSpikes.get(stateKey);
        if (existing) {
          existing.energy += injectedCurrent;
          existing.momentum = Math.max(existing.momentum, nextMomentum);
          if (spike.hop + 1 < existing.hop) {
            existing.hop = spike.hop + 1;
            existing.sourceType = spike.sourceType;
          }
        } else {
          nextSpikes.set(stateKey, {
            nodeId: neighborId,
            previousNodeId: spike.nodeId,
            energy: injectedCurrent,
            momentum: nextMomentum,
            sourceType: spike.sourceType,
            hop: spike.hop + 1
          });
        }
      }
    }

    if (nextSpikes.size > maxPropagationStates) {
      const retained = [...nextSpikes.entries()]
        .sort((a, b) => b[1].energy - a[1].energy)
        .slice(0, maxPropagationStates);
      diagnostics.stateTruncations += nextSpikes.size - retained.length;
      nextSpikes.clear();
      for (const [key, value] of retained) nextSpikes.set(key, value);
    }

    const nodeEnergyThisHop = new Map();
    for (const newSpike of nextSpikes.values()) {
      nodeEnergyThisHop.set(
        newSpike.nodeId,
        (nodeEnergyThisHop.get(newSpike.nodeId) || 0) + newSpike.energy
      );
      const numericNodeId = Number(newSpike.nodeId);
      const previousProvenance = fieldProvenance.get(numericNodeId);
      if (!previousProvenance || newSpike.hop < previousProvenance.hop) {
        fieldProvenance.set(numericNodeId, {
          sourceType: 'emergent',
          originType: newSpike.sourceType,
          hop: newSpike.hop
        });
      }
      inFlightMass += newSpike.energy;
    }
    diagnostics.hopInFlightMass.push(inFlightMass);

    const fieldWeight = firWeights[Math.min(hop + 1, firWeights.length - 1)];
    for (const [nodeId, energy] of nodeEnergyThisHop.entries()) {
      accumulatedEnergy.set(
        nodeId,
        (accumulatedEnergy.get(nodeId) || 0) + energy * fieldWeight
      );
      if (energy > 0.01) propagated = true;
    }

    if (!propagated) break;
    iterations += 1;
    currentSpikes = nextSpikes;
  }

  // Optional readout pruning relative to the peak activation.
  let prunedNodeCount = 0;
  const readoutKeys = [...accumulatedEnergy.keys()];
  const peakActivation = readoutKeys.reduce(
    (max, id) => Math.max(max, accumulatedEnergy.get(id) || 0),
    0
  );
  if (pruneAbove > 0 && peakActivation > 0) {
    for (const id of readoutKeys) {
      if ((accumulatedEnergy.get(id) || 0) < pruneAbove * peakActivation) {
        accumulatedEnergy.delete(id);
        fieldProvenance.delete(id);
        prunedNodeCount += 1;
      }
    }
  }
  diagnostics.prunedNodeCount = prunedNodeCount;

  const maximumNodeEnergy = Math.max(0, ...accumulatedEnergy.values());
  const maximumEdgeFlow = Math.max(
    0,
    ...[...riverEdgeFlow.values()].map(edge => edge.flow)
  );
  const riverGraph = {
    schema: RIVER_SCHEMA,
    nodes: [...accumulatedEnergy.entries()]
      .map(([rawId, rawEnergy]) => {
        const id = Number(rawId);
        const provenance = fieldProvenance.get(id) || {};
        const parent = strongestParentByNode.get(id) || null;
        return {
          id,
          energy: Math.max(0, Number(rawEnergy) || 0),
          normalizedEnergy: maximumNodeEnergy > 0
            ? Math.max(0, Number(rawEnergy) || 0) / maximumNodeEnergy
            : 0,
          sourceType: provenance.sourceType || 'unknown',
          originType: provenance.originType || null,
          hop: Number.isFinite(provenance.hop) ? provenance.hop : null,
          seedId: Number.isFinite(provenance.seedId) ? provenance.seedId : null,
          strongestParent: parent ? { ...parent } : null
        };
      })
      .sort((left, right) =>
        (right.energy - left.energy) || (left.id - right.id)
      ),
    edges: [...riverEdgeFlow.values()]
      .map(edge => ({
        ...edge,
        normalizedFlow: maximumEdgeFlow > 0 ? edge.flow / maximumEdgeFlow : 0
      }))
      .sort((left, right) =>
        (right.flow - left.flow)
        || (left.sourceId - right.sourceId)
        || (left.targetId - right.targetId)
      ),
    diagnostics: {
      seedNodes: sources.length,
      reachedNodes: accumulatedEnergy.size,
      activeEdges: riverEdgeFlow.size,
      maximumNodeEnergy,
      maximumEdgeFlow
    }
  };

  return {
    activations: accumulatedEnergy,
    fieldProvenance,
    riverGraph,
    iterations,
    diagnostics: {
      ...diagnostics,
      seedNodes: sources.length,
      reachedNodes: accumulatedEnergy.size,
      activeEdges: riverEdgeFlow.size
    }
  };
}

module.exports = {
  ALGORITHM_VERSION,
  RIVER_SCHEMA,
  computeFirWeights,
  adjacencyFromEdges,
  propagate
};