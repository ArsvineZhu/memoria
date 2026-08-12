import { createHash } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import type {
  MemoryRelationRecord,
  MemoryRelationStatus,
  RelationListOptions,
} from "../../types/relations.js";
import type { UnknownRecord } from "../../types/common.js";
import { RELATION_GENERATION_KEY } from "./schema.js";

export interface SqliteRunStatement {
  run(...params: readonly unknown[]): unknown;
}

interface RelationQueryRow {
  id: string;
  from_key: string;
  to_key: string;
  kind: string;
  origin: string;
  confidence: number;
  weight: number;
  evidence?: string | null;
  provenance_json?: string | null;
  source_revision?: string | null;
  algorithm_version?: string | null;
  source_span_start?: number | null;
  source_span_end?: number | null;
  target_anchor?: string | null;
  status: string;
  active: number;
  created_at: number;
  updated_at: number;
}

function relationInputId(from: string, to: string, kind: string): string {
  return createHash("sha256")
    .update(`${from}\n${to}\n${kind}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function parseRelationJson(value: string | null | undefined): UnknownRecord | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as UnknownRecord)
      : null;
  } catch {
    return null;
  }
}

function relationFromRow(row: RelationQueryRow): MemoryRelationRecord {
  const status =
    row.status === "stale" || row.status === "rejected" ? row.status : "active";
  return {
    id: row.id,
    from: row.from_key,
    to: row.to_key,
    kind: row.kind as MemoryRelationRecord["kind"],
    origin: row.origin === "derived" ? "derived" : "source",
    confidence: Number(row.confidence) || 0,
    weight: Number(row.weight) || 0,
    evidence: row.evidence ?? null,
    provenance: parseRelationJson(row.provenance_json),
    sourceRevision: row.source_revision ?? null,
    algorithmVersion: row.algorithm_version ?? null,
    sourceSpan:
      row.source_span_start == null || row.source_span_end == null
        ? null
        : { start: row.source_span_start, end: row.source_span_end },
    targetAnchor: row.target_anchor ?? null,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    status,
    active: row.active !== 0 && status === "active",
  };
}

type IncrementGeneration = () => number;
type ReadKv = (key: string) => Promise<string | null>;

/** Relation-specific SQLite persistence kept behind the metadata provider facade. */
class SqliteRelationRepository {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly incrementGeneration: IncrementGeneration,
    private readonly readKv: ReadKv,
  ) {}

  prepareUpsert(): SqliteRunStatement {
    return this.db.prepare(`
      INSERT INTO memory_relations (
        id, from_key, to_key, kind, origin, confidence, weight, evidence,
        provenance_json, source_revision, algorithm_version,
        source_span_start, source_span_end, target_anchor, status, active,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        from_key = excluded.from_key,
        to_key = excluded.to_key,
        kind = excluded.kind,
        origin = excluded.origin,
        confidence = excluded.confidence,
        weight = excluded.weight,
        evidence = excluded.evidence,
        provenance_json = excluded.provenance_json,
        source_revision = excluded.source_revision,
        algorithm_version = excluded.algorithm_version,
        source_span_start = excluded.source_span_start,
        source_span_end = excluded.source_span_end,
        target_anchor = excluded.target_anchor,
        status = excluded.status,
        active = excluded.active,
        updated_at = excluded.updated_at
    `) as unknown as SqliteRunStatement;
  }

  writeRelation(statement: SqliteRunStatement, relation: MemoryRelationRecord): void {
    statement.run(
      relation.id,
      relation.from,
      relation.to,
      relation.kind,
      relation.origin,
      Math.max(0, Math.min(1, Number(relation.confidence) || 0)),
      Math.max(0, Number(relation.weight) || 0),
      relation.evidence ?? null,
      relation.provenance ? JSON.stringify(relation.provenance) : null,
      relation.sourceRevision ?? null,
      relation.algorithmVersion ?? null,
      relation.sourceSpan?.start ?? null,
      relation.sourceSpan?.end ?? null,
      relation.targetAnchor ?? null,
      relation.status,
      relation.active ? 1 : 0,
      Number(relation.createdAt) || 0,
      Number(relation.updatedAt) || 0,
    );
  }

  async replaceExplicitRelations(
    from: string,
    sourceRevision: string,
    relations: readonly MemoryRelationRecord[],
  ): Promise<void> {
    this.db.transaction(() => {
      this.replaceSourceRelationsInTransaction(from, sourceRevision, relations, [from]);
    })();
  }

  replaceSourceRelationsInTransaction(
    from: string,
    sourceRevision: string | null,
    relations: readonly MemoryRelationRecord[],
    staleFromKeys: readonly string[] = [from],
    now = Date.now(),
  ): void {
    this.markSourceRelationsStaleInTransaction(staleFromKeys, now);
    const insert = this.prepareUpsert();
    for (const relation of relations) {
      this.writeRelation(insert, {
        ...relation,
        from,
        origin: "source",
        sourceRevision,
        status: "active",
        active: true,
        createdAt: Number(relation.createdAt) || now,
        updatedAt: now,
      });
    }
    this.incrementGeneration();
  }

  async upsertDerivedRelations(
    relations: readonly (Omit<
      MemoryRelationRecord,
      "id" | "origin" | "createdAt" | "updatedAt" | "status"
    > &
      Partial<
        Pick<
          MemoryRelationRecord,
          "id" | "origin" | "createdAt" | "updatedAt" | "status"
        >
      >)[],
  ): Promise<void> {
    if (relations.length === 0) return;
    const now = Date.now();
    this.db.transaction(() => {
      const find = this.db.prepare("SELECT * FROM memory_relations WHERE id = ?");
      const insert = this.prepareUpsert();

      for (const relation of relations) {
        const id =
          relation.id || relationInputId(relation.from, relation.to, relation.kind);
        const previous = find.get(id) as RelationQueryRow | undefined;
        const requestedStatus: MemoryRelationStatus =
          relation.status === "rejected"
            ? "rejected"
            : !(relation.active ?? true) || relation.status === "stale"
              ? "stale"
              : "active";
        const confidence = Math.max(0, Math.min(1, Number(relation.confidence) || 0));
        if (
          previous &&
          requestedStatus === "active" &&
          previous.status === "active" &&
          confidence < Number(previous.confidence)
        ) {
          continue;
        }
        this.writeRelation(insert, {
          id,
          from: relation.from,
          to: relation.to,
          kind: relation.kind,
          origin: "derived",
          confidence,
          weight: Math.max(0, Number(relation.weight) || 0),
          evidence: relation.evidence ?? null,
          provenance: relation.provenance ?? null,
          sourceRevision: relation.sourceRevision ?? null,
          algorithmVersion: relation.algorithmVersion ?? null,
          sourceSpan: relation.sourceSpan ?? null,
          targetAnchor: relation.targetAnchor ?? null,
          status: requestedStatus,
          active: requestedStatus === "active",
          createdAt: Number(relation.createdAt) || previous?.created_at || now,
          updatedAt: now,
        });
      }
      this.incrementGeneration();
    })();
  }

  async listRelations(
    options: RelationListOptions = {},
  ): Promise<MemoryRelationRecord[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (options.includeInactive !== true) {
      where.push("active = 1", "status = 'active'");
    }
    if (options.from !== undefined) {
      where.push("from_key = ?");
      values.push(options.from);
    }
    if (options.to !== undefined) {
      where.push("to_key = ?");
      values.push(options.to);
    }
    if (options.origins && options.origins.length > 0) {
      where.push(`origin IN (${options.origins.map(() => "?").join(",")})`);
      values.push(...options.origins);
    }
    if (options.kinds && options.kinds.length > 0) {
      where.push(`kind IN (${options.kinds.map(() => "?").join(",")})`);
      values.push(...options.kinds);
    }
    if (options.statuses && options.statuses.length > 0) {
      where.push(`status IN (${options.statuses.map(() => "?").join(",")})`);
      values.push(...options.statuses);
    }
    const sql = `SELECT * FROM memory_relations${
      where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
    } ORDER BY updated_at ASC, id ASC`;
    const rows = this.db.prepare(sql).all(...values) as RelationQueryRow[];
    return rows.map(relationFromRow);
  }

  async getRelationReadinessStats(): Promise<{
    explicitLinks: number;
    activeInferredLinks: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT origin, COUNT(*) AS count
         FROM memory_relations
         WHERE active = 1 AND status = 'active'
         GROUP BY origin`,
      )
      .all() as Array<{ origin: string; count: number }>;
    return {
      explicitLinks: Number(rows.find((row) => row.origin === "source")?.count) || 0,
      activeInferredLinks:
        Number(rows.find((row) => row.origin === "derived")?.count) || 0,
    };
  }

  async getAdjacentRelations(
    documentKeys: readonly string[],
  ): Promise<MemoryRelationRecord[]> {
    const keys = [...new Set(documentKeys.map(String).filter(Boolean))];
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_relations
         WHERE active = 1 AND status = 'active'
           AND (from_key IN (${placeholders}) OR to_key IN (${placeholders}))
         ORDER BY updated_at ASC, id ASC`,
      )
      .all(...keys, ...keys) as RelationQueryRow[];
    return rows.map(relationFromRow);
  }

  async markExplicitRelationsStale(from: string): Promise<void> {
    this.db.transaction(() => {
      if (this.markSourceRelationsStaleInTransaction([from], Date.now())) {
        this.incrementGeneration();
      }
    })();
  }

  markSourceRelationsStaleInTransaction(
    fromKeys: readonly string[],
    now = Date.now(),
  ): boolean {
    const keys = [...new Set(fromKeys.map(String).filter(Boolean))];
    let changed = false;
    const stale = this.db.prepare(
      `UPDATE memory_relations
       SET status = 'stale', active = 0, updated_at = ?
       WHERE from_key = ? AND origin = 'source' AND active = 1`,
    );
    for (const key of keys) {
      const result = stale.run(now, key) as { changes?: number };
      changed ||= Number(result.changes) > 0;
    }
    return changed;
  }

  incrementGenerationForTransaction(): number {
    return this.incrementGeneration();
  }

  async getRelationGeneration(): Promise<number> {
    const value = await this.readKv(RELATION_GENERATION_KEY);
    const parsed = Number.parseInt(value ?? "0", 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  }
}

export default SqliteRelationRepository;
