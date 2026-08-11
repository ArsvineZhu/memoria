"use strict";

import type { MemoryConfigOverrides } from "../types.js";

export type RetrievalStrategy = "auto" | "semantic" | "field" | "topology";

export interface RetrievalPlan {
  strategy: RetrievalStrategy;
  field?: {
    enabled?: boolean;
    geodesicRerank?: boolean;
  };
  topology?: {
    enabled?: boolean;
    version?: "v3";
    maxHops?: number;
    relatedExpansion?: boolean;
  };
  tagMemo?: {
    enabled?: boolean;
    plus?: boolean;
    version?: "v9" | "v10";
    geodesicRerank?: boolean;
  };
  riverMemo?: {
    enabled?: boolean;
    rerank?: boolean;
    version?: "v3";
    maxHops?: number;
  };
  filters?: {
    spaces?: readonly string[];
    documentIds?: readonly string[];
    recordedAfter?: number | string;
    recordedBefore?: number | string;
    metadata?: Record<string, unknown>;
  };
  externalRerank?: {
    enabled?: boolean;
    mode?: "ordered" | "rrf";
    alpha?: number;
  };
  expansion?: {
    related?: boolean;
    maxHops?: number;
    sameDocument?: boolean;
    fullDocument?: boolean;
    associate?: boolean;
    maxAdded?: number;
  };
  postprocess?: {
    timeDecay?: boolean;
    dedupe?: boolean;
    truncate?: boolean;
    /** Score floor applied by the truncation stage after rerank/decay. */
    minScore?: number;
    maxResults?: number;
    maxContentLength?: number;
  };
}

/**
 * Partially specified plan accepted by engine defaults, per-query overrides,
 * and the fluent query builder. `normalizeRetrievalPlan` turns it into a
 * detached canonical plan before it reaches a pipeline stage.
 */
export type RetrievalPlanInput = Omit<RetrievalPlan, "strategy"> & {
  strategy?: RetrievalStrategy;
};

function mergeRecord<T extends Record<string, unknown>>(
  base: T | undefined,
  override: Partial<T> | undefined,
): T | undefined {
  if (base === undefined && override === undefined) return undefined;
  return { ...(base || {}), ...(override || {}) } as T;
}

function mergeFilters(
  base: RetrievalPlan["filters"],
  override: RetrievalPlanInput["filters"],
): RetrievalPlan["filters"] {
  if (base === undefined && override === undefined) return undefined;
  return {
    spaces:
      override?.spaces !== undefined
        ? [...override.spaces]
        : base?.spaces === undefined
          ? undefined
          : [...base.spaces],
    documentIds:
      override?.documentIds !== undefined
        ? [...override.documentIds]
        : base?.documentIds === undefined
          ? undefined
          : [...base.documentIds],
    recordedAfter: override?.recordedAfter ?? base?.recordedAfter,
    recordedBefore: override?.recordedBefore ?? base?.recordedBefore,
    metadata:
      override?.metadata !== undefined
        ? { ...override.metadata }
        : base?.metadata === undefined
          ? undefined
          : { ...base.metadata },
  };
}

/**
 * Merge one query override over an engine default without mutating either
 * input. Core strategy sections are replaced when the query changes
 * strategy; filters, expansion, rerank, and postprocess remain layered.
 */
export function mergeRetrievalPlan(
  defaultPlan: RetrievalPlan,
  override?: RetrievalPlanInput,
  inheritDefaults = true,
): RetrievalPlanInput {
  assertValidRetrievalPlanInput(override);
  const base = inheritDefaults
    ? normalizeRetrievalPlan(defaultPlan)
    : normalizeRetrievalPlan({ strategy: "auto" });
  const patch = override || {};
  const strategy = patch.strategy ?? base.strategy;
  const strategyChanged =
    patch.strategy !== undefined && patch.strategy !== base.strategy;
  const coreBase = strategyChanged ? normalizeRetrievalPlan({ strategy }) : base;

  return {
    strategy,
    field: mergeRecord(coreBase.field, patch.field),
    topology: mergeRecord(coreBase.topology, patch.topology),
    tagMemo: mergeRecord(coreBase.tagMemo, patch.tagMemo),
    riverMemo: mergeRecord(coreBase.riverMemo, patch.riverMemo),
    filters: mergeFilters(base.filters, patch.filters),
    externalRerank: mergeRecord(base.externalRerank, patch.externalRerank),
    expansion: mergeRecord(base.expansion, patch.expansion),
    postprocess: mergeRecord(base.postprocess, patch.postprocess),
  };
}

/** Convert a normalized public plan into per-run pipeline gates. */
export function applyRetrievalPlan(input: RetrievalPlan): MemoryConfigOverrides {
  const plan = normalizeRetrievalPlan(input);
  const tagMemoEnabled = plan.tagMemo?.enabled === true;
  const topologyEnabled =
    plan.topology?.enabled === true || plan.riverMemo?.enabled === true;
  const sameDocumentExpansionEnabled = plan.expansion?.sameDocument === true;
  const fullDocumentExpansionEnabled = plan.expansion?.fullDocument === true;
  const associatorEnabled = plan.expansion?.associate === true;
  const relationExpansionEnabled =
    plan.expansion?.related === true || plan.topology?.relatedExpansion === true;
  const filters = plan.filters;
  const config: MemoryConfigOverrides = {
    retrievalPlan: plan,
    tagMemoV9Enabled: tagMemoEnabled,
    tagMemoV10Enabled: tagMemoEnabled && plan.tagMemo?.version === "v10",
    geodesicRerankEnabled:
      tagMemoEnabled &&
      (plan.tagMemo?.plus === true ||
        plan.tagMemo?.geodesicRerank === true ||
        plan.field?.geodesicRerank === true),
    nativeMemoEnabled: tagMemoEnabled || topologyEnabled,
    riverMemoEnabled: topologyEnabled,
    topologyV3Enabled: topologyEnabled && plan.riverMemo?.version === "v3",
    topologyMaxHops: plan.riverMemo?.maxHops ?? plan.topology?.maxHops ?? 2,
    relationExpansionEnabled,
    relationMaxHops: plan.expansion?.maxHops ?? plan.topology?.maxHops ?? 1,
    relationMaxAdded: plan.expansion?.maxAdded ?? 50,
    relationExpansionSeeds: 3,
    expansionEnabled: sameDocumentExpansionEnabled || fullDocumentExpansionEnabled,
    fullDocumentExpansionEnabled,
    associatorEnabled,
    expandCount: plan.expansion?.maxAdded ?? 50,
    externalRerankEnabled: plan.externalRerank?.enabled === true,
    useLLMRerank: plan.externalRerank?.enabled === true,
    externalRerankMode: plan.externalRerank?.mode ?? "ordered",
    externalRerankAlpha: plan.externalRerank?.alpha ?? 0.5,
    timeDecayEnabled: plan.postprocess?.timeDecay === true,
    dedupeEnabled: plan.postprocess?.dedupe !== false,
    truncateEnabled: plan.postprocess?.truncate === true,
    truncateMinScore: plan.postprocess?.minScore ?? 0,
    maxResults: plan.postprocess?.maxResults ?? 10,
    topK: plan.postprocess?.maxResults ?? 10,
    maxContentLength: plan.postprocess?.maxContentLength ?? 4000,
    retrievalFilters: filters,
  };
  if (filters && filters.spaces !== undefined) {
    // Preserve [] as an intentional fail-closed scope.
    config.indexNames = [...filters.spaces];
  }
  return config;
}

const STRATEGIES = new Set<RetrievalStrategy>([
  "auto",
  "semantic",
  "field",
  "topology",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidPlanParameter(path: string, message: string): never {
  throw new TypeError(`Invalid retrieval plan parameter ${path}: ${message}`);
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalidPlanParameter(path, "expected an object");
  return value;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalidPlanParameter(`${path}.${key}`, "unknown field");
  }
}

function assertBoolean(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    invalidPlanParameter(path, "expected a boolean");
  }
}

function assertEnum(value: unknown, path: string, values: readonly string[]): void {
  if (value !== undefined && (typeof value !== "string" || !values.includes(value))) {
    invalidPlanParameter(path, `expected one of ${values.join(", ")}`);
  }
}

function assertNumber(
  value: unknown,
  path: string,
  min: number,
  max: number,
  integer = false,
): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    invalidPlanParameter(
      path,
      integer
        ? `expected an integer in [${min}, ${max}]`
        : `expected a number in [${min}, ${max}]`,
    );
  }
}

function assertStringList(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    invalidPlanParameter(path, "expected an array of strings");
  }
}

/**
 * Validate the new plan-input boundaries without changing the historical
 * clamping behavior of normalizeRetrievalPlan() for direct callers.
 */
export function assertValidRetrievalPlanInput(input?: RetrievalPlanInput | null): void {
  if (input == null) return;
  const source = assertRecord(input, "plan");
  assertKnownKeys(source, "plan", [
    "strategy",
    "field",
    "topology",
    "tagMemo",
    "riverMemo",
    "filters",
    "externalRerank",
    "expansion",
    "postprocess",
  ]);
  assertEnum(source.strategy, "strategy", ["auto", "semantic", "field", "topology"]);

  if (source.field !== undefined) {
    const field = assertRecord(source.field, "field");
    assertKnownKeys(field, "field", ["enabled", "geodesicRerank"]);
    assertBoolean(field.enabled, "field.enabled");
    assertBoolean(field.geodesicRerank, "field.geodesicRerank");
  }
  if (source.topology !== undefined) {
    const topology = assertRecord(source.topology, "topology");
    assertKnownKeys(topology, "topology", [
      "enabled",
      "version",
      "maxHops",
      "relatedExpansion",
    ]);
    assertBoolean(topology.enabled, "topology.enabled");
    assertEnum(topology.version, "topology.version", ["v3"]);
    assertNumber(topology.maxHops, "topology.maxHops", 0, 4, true);
    assertBoolean(topology.relatedExpansion, "topology.relatedExpansion");
  }
  if (source.tagMemo !== undefined) {
    const tagMemo = assertRecord(source.tagMemo, "tagMemo");
    assertKnownKeys(tagMemo, "tagMemo", [
      "enabled",
      "plus",
      "version",
      "geodesicRerank",
    ]);
    assertBoolean(tagMemo.enabled, "tagMemo.enabled");
    assertBoolean(tagMemo.plus, "tagMemo.plus");
    assertEnum(tagMemo.version, "tagMemo.version", ["v9", "v10"]);
    assertBoolean(tagMemo.geodesicRerank, "tagMemo.geodesicRerank");
  }
  if (source.riverMemo !== undefined) {
    const riverMemo = assertRecord(source.riverMemo, "riverMemo");
    assertKnownKeys(riverMemo, "riverMemo", [
      "enabled",
      "rerank",
      "version",
      "maxHops",
    ]);
    assertBoolean(riverMemo.enabled, "riverMemo.enabled");
    assertBoolean(riverMemo.rerank, "riverMemo.rerank");
    assertEnum(riverMemo.version, "riverMemo.version", ["v3"]);
    assertNumber(riverMemo.maxHops, "riverMemo.maxHops", 0, 4, true);
  }
  if (source.filters !== undefined) {
    const filters = assertRecord(source.filters, "filters");
    assertKnownKeys(filters, "filters", [
      "spaces",
      "documentIds",
      "recordedAfter",
      "recordedBefore",
      "metadata",
    ]);
    assertStringList(filters.spaces, "filters.spaces");
    assertStringList(filters.documentIds, "filters.documentIds");
    if (
      filters.recordedAfter !== undefined &&
      !(
        (typeof filters.recordedAfter === "number" &&
          Number.isFinite(filters.recordedAfter)) ||
        typeof filters.recordedAfter === "string"
      )
    ) {
      invalidPlanParameter(
        "filters.recordedAfter",
        "expected a finite number or string",
      );
    }
    if (
      filters.recordedBefore !== undefined &&
      !(
        (typeof filters.recordedBefore === "number" &&
          Number.isFinite(filters.recordedBefore)) ||
        typeof filters.recordedBefore === "string"
      )
    ) {
      invalidPlanParameter(
        "filters.recordedBefore",
        "expected a finite number or string",
      );
    }
    if (filters.metadata !== undefined)
      assertRecord(filters.metadata, "filters.metadata");
  }
  if (source.externalRerank !== undefined) {
    const rerank = assertRecord(source.externalRerank, "externalRerank");
    assertKnownKeys(rerank, "externalRerank", ["enabled", "mode", "alpha"]);
    assertBoolean(rerank.enabled, "externalRerank.enabled");
    assertEnum(rerank.mode, "externalRerank.mode", ["ordered", "rrf"]);
    assertNumber(rerank.alpha, "externalRerank.alpha", 0, 1);
  }
  if (source.expansion !== undefined) {
    const expansion = assertRecord(source.expansion, "expansion");
    assertKnownKeys(expansion, "expansion", [
      "related",
      "maxHops",
      "sameDocument",
      "fullDocument",
      "associate",
      "maxAdded",
    ]);
    for (const key of ["related", "sameDocument", "fullDocument", "associate"]) {
      assertBoolean(expansion[key], `expansion.${key}`);
    }
    assertNumber(expansion.maxHops, "expansion.maxHops", 0, 4, true);
    assertNumber(expansion.maxAdded, "expansion.maxAdded", 0, 1000, true);
  }
  if (source.postprocess !== undefined) {
    const postprocess = assertRecord(source.postprocess, "postprocess");
    assertKnownKeys(postprocess, "postprocess", [
      "timeDecay",
      "dedupe",
      "truncate",
      "minScore",
      "maxResults",
      "maxContentLength",
    ]);
    for (const key of ["timeDecay", "dedupe", "truncate"]) {
      assertBoolean(postprocess[key], `postprocess.${key}`);
    }
    assertNumber(postprocess.minScore, "postprocess.minScore", 0, 1);
    assertNumber(postprocess.maxResults, "postprocess.maxResults", 1, 1000, true);
    assertNumber(
      postprocess.maxContentLength,
      "postprocess.maxContentLength",
      0,
      100_000,
      true,
    );
  }
}

function cloneMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneMetadataValue);
  if (!isRecord(value)) return value;
  const clone: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    clone[key] = cloneMetadataValue(nested);
  }
  return clone;
}

function deepFreeze(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

/** Freeze an engine-owned normalized plan and all of its detached children. */
export function freezeRetrievalPlan(plan: RetrievalPlan): RetrievalPlan {
  return deepFreeze(plan) as RetrievalPlan;
}

function clampInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function cloneStringList(value: readonly string[] | undefined): string[] | undefined {
  return value === undefined ? undefined : [...value];
}

function cloneMetadata(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return value === undefined
    ? undefined
    : (cloneMetadataValue(value) as Record<string, unknown>);
}

/**
 * Normalize the library-native retrieval plan.
 *
 * The returned object is detached from caller-owned arrays and metadata so a
 * pipeline can safely carry it across stages without mutating request input.
 */
export function normalizeRetrievalPlan(
  input?: RetrievalPlanInput | null,
): RetrievalPlan {
  const source = input ?? { strategy: "auto" as const };
  const strategy = source.strategy ?? "auto";
  if (!STRATEGIES.has(strategy)) {
    throw new TypeError(`Unknown retrieval strategy: ${String(strategy)}`);
  }

  const field = source.field ?? {};
  const topology = source.topology ?? {};
  const tagMemo = source.tagMemo ?? {};
  const riverMemo = source.riverMemo ?? {};
  const filters = source.filters;
  const externalRerank = source.externalRerank ?? {};
  const expansion = source.expansion ?? {};
  const postprocess = source.postprocess ?? {};

  return {
    strategy,
    field: {
      enabled: field.enabled ?? strategy === "field",
      geodesicRerank: field.geodesicRerank ?? false,
    },
    topology: {
      enabled: topology.enabled ?? strategy === "topology",
      version: topology.version ?? "v3",
      maxHops: clampInteger(topology.maxHops, 0, 4, 2),
      relatedExpansion: topology.relatedExpansion ?? false,
    },
    tagMemo: {
      enabled: tagMemo.enabled ?? field.enabled ?? strategy === "field",
      // Keep plain TagMemo and TagMemo+ distinct. Automatic field planning
      // opts into plus explicitly; a caller selecting field/TagMemo alone
      // should not receive geodesic/DTSC reranking as an implicit side effect.
      plus: tagMemo.plus ?? field.geodesicRerank ?? false,
      version: tagMemo.version ?? "v10",
      geodesicRerank: tagMemo.geodesicRerank ?? field.geodesicRerank ?? false,
    },
    riverMemo: {
      enabled: riverMemo.enabled ?? topology.enabled ?? strategy === "topology",
      rerank:
        riverMemo.rerank ??
        riverMemo.enabled ??
        topology.enabled ??
        strategy === "topology",
      version: riverMemo.version ?? "v3",
      maxHops: clampInteger(riverMemo.maxHops ?? topology.maxHops, 0, 4, 2),
    },
    filters: filters
      ? {
          spaces: cloneStringList(filters.spaces),
          documentIds: cloneStringList(filters.documentIds),
          recordedAfter: filters.recordedAfter,
          recordedBefore: filters.recordedBefore,
          metadata: cloneMetadata(filters.metadata),
        }
      : undefined,
    externalRerank: {
      enabled: externalRerank.enabled ?? false,
      mode: externalRerank.mode ?? "ordered",
      alpha: clampNumber(externalRerank.alpha, 0, 1, 0.5),
    },
    expansion: {
      related: expansion.related ?? false,
      maxHops: clampInteger(expansion.maxHops, 0, 4, 1),
      sameDocument: expansion.sameDocument ?? false,
      fullDocument: expansion.fullDocument ?? false,
      associate: expansion.associate ?? false,
      maxAdded: clampInteger(expansion.maxAdded, 0, 1000, 50),
    },
    postprocess: {
      timeDecay: postprocess.timeDecay ?? false,
      dedupe: postprocess.dedupe ?? true,
      truncate: postprocess.truncate ?? false,
      minScore: clampNumber(postprocess.minScore, 0, 1, 0),
      maxResults: clampInteger(postprocess.maxResults, 1, 1000, 10),
      maxContentLength: clampInteger(postprocess.maxContentLength, 0, 100_000, 4000),
    },
  };
}
