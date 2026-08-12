import { at } from "../../utils/numerical.js";
import type { UnknownRecord } from "../../types/common.js";
import type {
  ActivationSeed,
  ActivationSeedInput,
  EdgeInput,
  NeighborInput,
} from "./activation-propagation-types.js";

export function clamp01(value: unknown): number {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function fin(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function integer(value: unknown, fallback: number): number {
  const numeric = fin(value, fallback);
  return Math.max(0, Math.floor(numeric));
}

export function mapValue(
  source: Map<number, number> | UnknownRecord | undefined,
  key: number,
): unknown {
  if (!source) return undefined;
  if (source instanceof Map) return source.get(key);
  const result = source[String(key)];
  return result === undefined ? null : result;
}

export function computeFirWeights(gamma: number, propagationMaxHops: number): number[] {
  const clampedGamma = Math.max(0.05, Math.min(0.95, fin(gamma, 0.6)));
  const taps = Math.max(0, integer(propagationMaxHops, 4));
  const weights: number[] = [];
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

export function sourceEntries(sources: unknown): ActivationSeed[] {
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

export function neighborMap(neighbors: NeighborInput): Map<number, number> {
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
      if (Number.isFinite(id) && Number.isFinite(weight)) result.set(id, weight);
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

export function adjacencyFromEdges(
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
    ) {
      continue;
    }
    if (!adjacency.has(fromId)) adjacency.set(fromId, new Map());
    const row = adjacency.get(fromId);
    if (!row) continue;
    row.set(toId, (row.get(toId) || 0) + weight);
  }
  return adjacency;
}

export function neighborsOf(
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
