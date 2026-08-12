import type { ChunkCandidate } from "../../types/documents.js";
import type { MemoryConfigOverrides } from "../../types/config.js";
import type { PipelineData } from "../../types/pipeline.js";
import type { PropagationTrace } from "../../types/retrieval.js";
import { computePropagationSpread } from "../../algorithms/tag-graph/propagation-spread.js";
import type { PropagationStructureRankingResult } from "./propagation-structure-types.js";

function numeric(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function currentNodeTotals(propagationTrace: PropagationTrace): Map<number, number> {
  const totals = new Map<number, number>();
  for (const edge of propagationTrace.edges || []) {
    const targetId = numeric(edge?.targetId, NaN);
    const flow = Math.max(0, numeric(edge?.flow));
    if (!Number.isFinite(targetId) || flow <= 0) continue;
    totals.set(targetId, (totals.get(targetId) || 0) + flow);
  }
  return totals;
}

function readNodeTotals(
  input: PipelineData,
  propagationTrace: PropagationTrace,
): Map<number, number> {
  const persisted = input.propagationHistory?.nodeTotals;
  if (persisted && typeof persisted === "object") {
    const totals = new Map<number, number>();
    for (const [key, value] of Object.entries(persisted)) {
      const id = numeric(key, NaN);
      const total = Math.max(0, numeric(value));
      if (Number.isFinite(id) && total > 0) totals.set(id, total);
    }
    return totals;
  }
  return currentNodeTotals(propagationTrace);
}

/** Deterministic local fallback for propagation-structure ranking. */
export function rankPropagationStructure(
  input: PipelineData,
  config: MemoryConfigOverrides,
): PropagationStructureRankingResult {
  const propagationTrace: PropagationTrace = input.tagGraphPropagation
    ?.propagationTrace || {
    nodes: [],
    edges: [],
    diagnostics: {},
  };
  const spread = computePropagationSpread({
    nodes: propagationTrace.nodes,
    edges: propagationTrace.edges,
    diagnostics: propagationTrace.diagnostics || {},
  });
  const nodeTotals = readNodeTotals(input, propagationTrace);
  const historySupport = Math.max(
    0,
    Math.min(1, numeric(input.propagationHistory?.historySupport, 0)),
  );
  const mergedCandidates = rerankCandidates(
    input.mergedCandidates,
    spread.spreadClass,
    nodeTotals,
    config,
  );

  return {
    mergedCandidates,
    spreadClass: spread.spreadClass,
    spreadScore: spread.spreadScore,
    historySupport,
    nodeTotals: Object.fromEntries(
      [...nodeTotals.entries()].sort(([left], [right]) => left - right),
    ),
    activeEdges: spread.activeEdges,
    nodeCount: spread.reachedNodes,
    edgeCount: spread.activeEdges,
  };
}

function rerankCandidates(
  candidates: readonly ChunkCandidate[] | undefined,
  spreadClass: string,
  nodeTotals: Map<number, number>,
  config: MemoryConfigOverrides,
): ChunkCandidate[] {
  const source = Array.isArray(candidates) ? candidates : [];
  if (source.length === 0) return source;

  const inactive = spreadClass === "inactive";
  const cap = Math.max(0, numeric(config.historyRerankCap, 0.08));
  const results: ChunkCandidate[] = [];
  for (const candidate of source) {
    const tagIds = Array.isArray(candidate.tags)
      ? candidate.tags.map(Number).filter(Number.isFinite)
      : [];
    let support = 0;
    for (const id of tagIds) support = Math.max(support, numeric(nodeTotals.get(id)));
    const score = inactive
      ? numeric(candidate.score)
      : Math.max(
          0,
          Math.min(
            1,
            numeric(candidate.score) + Math.min(cap, cap * Math.min(1, support)),
          ),
        );
    results.push({
      ...candidate,
      score,
      historySupport: support,
      spreadClass,
    });
  }
  results.sort(
    (left, right) => right.score - left.score || left.chunkId - right.chunkId,
  );
  return results;
}
