import type BetterSqlite3 from "better-sqlite3";

import type {
  PropagationHistoryObservation,
  PropagationHistorySnapshot,
} from "../../types/retrieval.js";

interface HistoryStateRow {
  sequence: number;
  total_mass: number;
}

interface HistoryEdgeRow {
  source_id: number;
  target_id: number;
  total: number;
}

/** Owns atomic propagation-history snapshots and observation commits. */
export default class SqlitePropagationHistoryRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  read(nodeIds: readonly number[]): PropagationHistorySnapshot {
    const state = this.readState();
    const ids = [...new Set(nodeIds.map(Number).filter(Number.isFinite))];
    if (ids.length === 0) {
      return { sequence: state.sequence, totalMass: state.total_mass, edgeTotals: [] };
    }

    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT source_id, target_id, total
         FROM propagation_history_edges
         WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
         ORDER BY source_id, target_id`,
      )
      .all(...ids, ...ids) as HistoryEdgeRow[];
    return this.snapshot(state, rows);
  }

  commit(observation: PropagationHistoryObservation): PropagationHistorySnapshot {
    const edgeIncrements = observation.edges.filter(
      (edge) =>
        Number.isSafeInteger(edge.sourceId) &&
        Number.isSafeInteger(edge.targetId) &&
        Number.isFinite(edge.increment) &&
        edge.increment > 0,
    );
    const nodeIds = [
      ...new Set([
        ...observation.nodeIds,
        ...edgeIncrements.flatMap((edge) => [edge.sourceId, edge.targetId]),
      ]),
    ];
    const transaction = this.db.transaction(() => {
      const state = this.readState();
      const sequence = state.sequence + 1;
      const totalMass =
        state.total_mass +
        edgeIncrements.reduce((sum, edge) => sum + edge.increment, 0);

      const upsertEdge = this.db.prepare(
        `INSERT INTO propagation_history_edges (source_id, target_id, total, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source_id, target_id) DO UPDATE SET
           total = propagation_history_edges.total + excluded.total,
           updated_at = excluded.updated_at`,
      );
      const now = Date.now();
      for (const edge of edgeIncrements) {
        upsertEdge.run(edge.sourceId, edge.targetId, edge.increment, now);
      }

      this.db
        .prepare(
          `UPDATE propagation_history_state
           SET sequence = ?, total_mass = ?
           WHERE id = 1`,
        )
        .run(sequence, totalMass);

      const snapshot = this.read(nodeIds);
      return {
        ...snapshot,
        sequence,
        totalMass,
      };
    });
    return transaction.immediate();
  }

  private readState(): HistoryStateRow {
    const row = this.db
      .prepare(
        "SELECT sequence, total_mass FROM propagation_history_state WHERE id = 1",
      )
      .get() as HistoryStateRow | undefined;
    if (!row) {
      throw new Error("Canonical propagation history state is missing.");
    }
    return {
      sequence: Number(row.sequence),
      total_mass: Number(row.total_mass),
    };
  }

  private snapshot(
    state: HistoryStateRow,
    rows: readonly HistoryEdgeRow[],
  ): PropagationHistorySnapshot {
    return {
      sequence: state.sequence,
      totalMass: state.total_mass,
      edgeTotals: rows.map(
        (row) =>
          [
            `${Number(row.source_id)}:${Number(row.target_id)}`,
            Number(row.total),
          ] as const,
      ),
    };
  }
}
