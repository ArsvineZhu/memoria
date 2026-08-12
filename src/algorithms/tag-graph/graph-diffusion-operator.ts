import type { UnknownRecord } from "../../types/common.js";
import { at } from "../../utils/numerical.js";
import { vectorMass } from "./graph-diffusion-math.js";
import type {
  DistributionOperator,
  OperatorDiagnostics,
  SolverOptions,
} from "./graph-diffusion-types.js";

interface RowEdge {
  targetIndex: number;
  targetId: number;
  weight: number;
}

interface OperatorRow {
  sourceId: number;
  sourceIndex: number;
  edges: RowEdge[];
  rowSum: number;
}

/** Build a deterministic row-normalized operator from a tag adjacency map. */
export function buildRowOperator(
  adjacency: Map<number, Map<number, number>>,
  options: { weight?: (weight: number) => number } = {},
): DistributionOperator {
  const seen = new Set<number>();
  if (adjacency instanceof Map) {
    for (const [id, row] of adjacency.entries()) {
      const numericId = Number(id);
      if (Number.isFinite(numericId)) seen.add(numericId);
      if (row instanceof Map) {
        for (const neighborId of row.keys()) {
          const numericNeighbor = Number(neighborId);
          if (Number.isFinite(numericNeighbor)) seen.add(numericNeighbor);
        }
      }
    }
  }
  const sortedIds = [...seen].sort((a, b) => a - b);
  const nodeCount = sortedIds.length;
  const indexById = new Map(sortedIds.map((id, index) => [id, index]));
  const rows: OperatorRow[] = [];

  for (const sourceId of sortedIds) {
    const rawRow = adjacency.get(sourceId);
    const rawEdges = rawRow instanceof Map ? [...rawRow.entries()] : [];
    const rowEntries: RowEdge[] = [];
    let rowSum = 0;
    for (const [targetId, rawWeight] of rawEdges) {
      const targetIndex = indexById.get(Number(targetId));
      if (targetIndex === undefined) continue;
      let weight = Number(rawWeight) || 0;
      if (typeof options.weight === "function") weight = options.weight(weight);
      if (!Number.isFinite(weight) || weight <= 0) continue;
      rowEntries.push({ targetIndex, targetId: Number(targetId), weight });
      rowSum += weight;
    }
    rowEntries.sort((a, b) => a.targetIndex - b.targetIndex);
    const sourceIndex = indexById.get(sourceId);
    if (sourceIndex === undefined) continue;
    rows.push({ sourceId, sourceIndex, edges: rowEntries, rowSum });
  }

  const operatorSig = `rows:${nodeCount}:${rows.length}:${sortedIds.join(",")}`;
  const apply = (
    input: Float64Array,
    output = new Float64Array(nodeCount),
    diagnostics?: OperatorDiagnostics,
  ): Float64Array => {
    if (!input || input.length !== nodeCount) {
      throw new RangeError(`Operator input length must be ${nodeCount}`);
    }
    output.fill(0);
    let visitedEdges = 0;
    let propagatedMass = 0;
    for (const row of rows) {
      const sourceMass = Number(input[row.sourceIndex]) || 0;
      if (!(sourceMass > 0) || !(row.rowSum > 0)) continue;
      const inverseRowSum = 1 / row.rowSum;
      for (const edge of row.edges) {
        if (edge.weight <= 0) continue;
        visitedEdges += 1;
        const mass = sourceMass * edge.weight * inverseRowSum;
        output[edge.targetIndex] =
          at(output, edge.targetIndex, "operator output") + mass;
        propagatedMass += mass;
      }
    }
    if (diagnostics && typeof diagnostics === "object") {
      diagnostics.visitedEdges = visitedEdges;
      diagnostics.propagatedMass = propagatedMass;
    }
    return output;
  };

  return {
    nodeCount,
    nodeIndexOf: (id) => indexById.get(Number(id)),
    nodeIdAt: (index) => at(sortedIds, index, "sorted ids"),
    operatorSig,
    apply,
    forEachEdge(sourceId, callback) {
      const row = rows.find((candidate) => candidate.sourceId === Number(sourceId));
      if (!row) return;
      for (const edge of row.edges) callback(edge.targetId, edge.weight, {});
    },
  };
}

/** Convert map, tuple-list, or vector seeds into a normalized operator-space vector. */
export function normalizeSource(
  operator: DistributionOperator,
  seedDistribution: SolverOptions["seedDistribution"],
): Float64Array {
  const source = new Float64Array(operator.nodeCount);
  if (seedDistribution instanceof Map) {
    for (const [rawId, rawMass] of seedDistribution.entries()) {
      const index = operator.nodeIndexOf(rawId);
      const mass = Math.max(0, Number(rawMass) || 0);
      if (index !== undefined && mass > 0) {
        source[index] = at(source, index, "seed distribution") + mass;
      }
    }
  } else if (Array.isArray(seedDistribution)) {
    for (const entry of seedDistribution as readonly (readonly unknown[])[]) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const index = operator.nodeIndexOf(entry[0]);
      const mass = Math.max(0, Number(entry[1]) || 0);
      if (index !== undefined && mass > 0) {
        source[index] = at(source, index, "seed distribution") + mass;
      }
    }
  } else if (seedDistribution && typeof seedDistribution.length === "number") {
    if (seedDistribution.length !== operator.nodeCount) {
      throw new RangeError(`Source distribution length must be ${operator.nodeCount}`);
    }
    const values = seedDistribution as ArrayLike<number>;
    for (let index = 0; index < source.length; index++) {
      source[index] = Math.max(0, Number(at(values, index, "seed distribution")) || 0);
    }
  }

  const mass = vectorMass(source);
  if (mass <= 0) {
    const error = new Error(
      "Graph diffusion seed distribution contains no positive mass",
    );
    Object.assign(error, { code: "TAG_RETRIEVAL_EMPTY_SOURCE" });
    throw error;
  }
  for (let index = 0; index < source.length; index++) {
    source[index] = at(source, index, "seed distribution") / mass;
  }
  return source;
}

export type { UnknownRecord };
