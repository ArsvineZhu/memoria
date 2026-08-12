import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";
import type {
  PropagationHistoryData,
  PropagationHistoryEdgeIncrement,
  PropagationHistoryObservation,
  PropagationHistorySnapshot,
  PropagationTrace,
} from "../../types/retrieval.js";

import Stage from "../../core/stage.js";
import { computePropagationSpread } from "../../algorithms/tag-graph/propagation-spread.js";

export const PROPAGATION_HISTORY_SCHEMA = "propagation-history-v2";

function finiteNonNegative(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function edgeKey(sourceId: number, targetId: number): string {
  return `${sourceId}:${targetId}`;
}

function edgeTarget(key: string): number | null {
  const separator = key.indexOf(":");
  if (separator < 1) return null;
  const target = Number(key.slice(separator + 1));
  return Number.isFinite(target) ? target : null;
}

function sortedEntries(values: Map<string, number>): Array<[string, number]> {
  return [...values.entries()]
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .sort(([left], [right]) => left.localeCompare(right));
}

function nodeTotals(edgeTotals: Map<string, number>): Map<number, number> {
  const totals = new Map<number, number>();
  for (const [key, value] of edgeTotals) {
    const target = edgeTarget(key);
    if (target === null) continue;
    totals.set(target, (totals.get(target) || 0) + value);
  }
  return totals;
}

function historySupport(totalMass: number): number {
  return Math.max(0, Math.min(1, Number(totalMass) || 0));
}

function snapshotMap(snapshot: PropagationHistorySnapshot): Map<string, number> {
  const edgeTotals = new Map<string, number>();
  for (const [key, value] of snapshot.edgeTotals) {
    const total = finiteNonNegative(value);
    if (total > 0 && edgeTarget(key) !== null) edgeTotals.set(key, total);
  }
  return edgeTotals;
}

function traceNodeIds(trace: PropagationTrace): number[] {
  const ids = new Set<number>();
  for (const node of trace.nodes || []) {
    const id = Number(node?.id);
    if (Number.isFinite(id)) ids.add(id);
  }
  for (const edge of trace.edges || []) {
    const sourceId = Number(edge?.sourceId);
    const targetId = Number(edge?.targetId);
    if (Number.isFinite(sourceId)) ids.add(sourceId);
    if (Number.isFinite(targetId)) ids.add(targetId);
  }
  return [...ids].sort((left, right) => left - right);
}

/** Persist canonical propagation history independently from structure reranking. */
class PropagationHistoryStage extends Stage {
  constructor() {
    super();
    this.name = "propagationHistory";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "propagationHistory"> & {
      propagationHistory?: PropagationHistoryData;
      propagationHistoryObservation?: PropagationHistoryObservation;
      propagationHistorySkipped?: boolean;
    }
  > {
    const info = input || {};
    if (ctx.config.propagationHistoryEnabled !== true) {
      return { ...info, propagationHistorySkipped: true };
    }

    const store = ctx.propagationHistoryStore;
    if (
      !store ||
      typeof store.readPropagationHistory !== "function" ||
      typeof store.commitPropagationObservation !== "function"
    ) {
      return {
        ...info,
        propagationHistorySkipped: true,
        propagationHistorySkipReason: "history persistence capability unavailable",
      };
    }

    const configuredScale = Number(ctx.config.historyUpdateScale);
    const scale = Number.isFinite(configuredScale) ? Math.max(0, configuredScale) : 1;
    const propagationTrace: PropagationTrace = info.tagRetrievalObservation?.propagation
      ?.propagationTrace ||
      info.tagGraphPropagation?.propagationTrace || {
        nodes: [],
        edges: [],
        diagnostics: {},
      };
    const nodeIds = traceNodeIds(propagationTrace);
    const snapshot = await store.readPropagationHistory(nodeIds);
    const edgeTotals = snapshotMap(snapshot);
    const observationEdges: PropagationHistoryEdgeIncrement[] = [];
    let tickFlowMass = 0;
    let activeEdges = 0;

    for (const edge of propagationTrace.edges || []) {
      const sourceId = Number(edge?.sourceId);
      const targetId = Number(edge?.targetId);
      const flow = finiteNonNegative(edge?.flow);
      if (!Number.isFinite(sourceId) || !Number.isFinite(targetId) || flow <= 0)
        continue;
      const increment = flow * scale;
      if (increment <= 0) continue;
      const key = edgeKey(sourceId, targetId);
      edgeTotals.set(key, (edgeTotals.get(key) || 0) + increment);
      observationEdges.push({ sourceId, targetId, increment });
      tickFlowMass += increment;
      activeEdges += 1;
    }

    const totals = nodeTotals(edgeTotals);
    const spread = computePropagationSpread({
      nodes: propagationTrace.nodes,
      edges: propagationTrace.edges,
      diagnostics: propagationTrace.diagnostics || {},
    });
    const entries = sortedEntries(edgeTotals);
    const sequence = snapshot.sequence + 1;
    const totalMass = snapshot.totalMass + tickFlowMass;

    return {
      ...info,
      propagationHistory: {
        schema: PROPAGATION_HISTORY_SCHEMA,
        sequence,
        edgeTotals: entries,
        spreadClass: spread.spreadClass,
        spreadScore: spread.spreadScore,
        historySupport: historySupport(totalMass),
        nodeTotals: Object.fromEntries(
          [...totals.entries()].sort(([left], [right]) => left - right),
        ),
        activeEdges,
        tickFlowMass,
      },
      propagationHistoryObservation: {
        nodeIds,
        edges: observationEdges,
        propagationTrace,
      },
    };
  }
}

export default PropagationHistoryStage;
