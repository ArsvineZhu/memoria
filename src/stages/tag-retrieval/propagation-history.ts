import type {
  PipelineContextLike,
  PipelineData,
} from "../../types/pipeline.js";
import type {
  PropagationHistoryData,
  PropagationHistoryStore,
  PropagationTrace,
} from "../../types/retrieval.js";

import Stage from "../../core/stage.js";
import { computePropagationSpread } from "../../algorithms/tag-graph/propagation-spread.js";

export const PROPAGATION_HISTORY_KEY = "propagation_history";
export const PROPAGATION_HISTORY_SCHEMA = "propagation-history-v1";

export interface PropagationHistoryState {
  sequence: number;
  edgeTotals: Map<string, number>;
}

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function historySupport(edgeTotals: Map<string, number>): number {
  const mass = [...edgeTotals.values()].reduce((sum, value) => sum + value, 0);
  return Math.max(0, Math.min(1, mass));
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
      typeof store.getKv !== "function" ||
      typeof store.setKv !== "function"
    ) {
      return { ...info, propagationHistorySkipped: true };
    }

    const state = await this._loadState(store);
    const sequence = state.sequence + 1;
    const scale = Math.max(0, Number(ctx.config.historyUpdateScale) || 1);
    const propagationTrace: PropagationTrace = info.tagGraphPropagation
      ?.propagationTrace || {
      nodes: [],
      edges: [],
      diagnostics: {},
    };
    let tickFlowMass = 0;
    let activeEdges = 0;

    for (const edge of propagationTrace.edges || []) {
      const sourceId = Number(edge?.sourceId);
      const targetId = Number(edge?.targetId);
      const flow = finiteNonNegative(edge?.flow);
      if (!Number.isFinite(sourceId) || !Number.isFinite(targetId) || flow <= 0)
        continue;
      const increment = flow * scale;
      const key = edgeKey(sourceId, targetId);
      state.edgeTotals.set(key, (state.edgeTotals.get(key) || 0) + increment);
      tickFlowMass += increment;
      activeEdges += 1;
    }

    const totals = nodeTotals(state.edgeTotals);
    const spread = computePropagationSpread({
      nodes: propagationTrace.nodes,
      edges: propagationTrace.edges,
      diagnostics: propagationTrace.diagnostics || {},
    });
    const entries = sortedEntries(state.edgeTotals);
    const persisted = {
      schema: PROPAGATION_HISTORY_SCHEMA,
      sequence,
      edgeTotals: Object.fromEntries(entries),
    };
    await store.setKv(PROPAGATION_HISTORY_KEY, JSON.stringify(persisted));

    return {
      ...info,
      propagationHistory: {
        schema: PROPAGATION_HISTORY_SCHEMA,
        sequence,
        edgeTotals: entries,
        spreadClass: spread.spreadClass,
        spreadScore: spread.spreadScore,
        historySupport: historySupport(state.edgeTotals),
        nodeTotals: Object.fromEntries(
          [...totals.entries()].sort(([left], [right]) => left - right),
        ),
        activeEdges,
        tickFlowMass,
      },
    };
  }

  private async _loadState(
    store: PropagationHistoryStore,
  ): Promise<PropagationHistoryState> {
    let raw: string | Record<string, unknown> | null = null;
    try {
      raw = await store.getKv(PROPAGATION_HISTORY_KEY);
    } catch {
      raw = null;
    }
    if (!raw) return { sequence: 0, edgeTotals: new Map() };

    try {
      const parsed = asRecord(typeof raw === "string" ? JSON.parse(raw) : raw);
      if (!parsed || parsed.schema !== PROPAGATION_HISTORY_SCHEMA) {
        return { sequence: 0, edgeTotals: new Map() };
      }
      const rawTotals = asRecord(parsed.edgeTotals) || {};
      const edgeTotals = new Map<string, number>();
      for (const [key, value] of Object.entries(rawTotals)) {
        const total = finiteNonNegative(value);
        if (total > 0 && edgeTarget(key) !== null) edgeTotals.set(key, total);
      }
      return {
        sequence: Math.max(0, Math.trunc(Number(parsed.sequence) || 0)),
        edgeTotals,
      };
    } catch {
      return { sequence: 0, edgeTotals: new Map() };
    }
  }
}

export default PropagationHistoryStage;
