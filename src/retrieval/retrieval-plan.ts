"use strict";

import type { MemoryConfigOverrides } from "../types.js";

export type RetrievalStrategy = "auto" | "semantic" | "associative" | "structural";

export interface RetrievalPlan {
  strategy: RetrievalStrategy;
  associative?: {
    enabled?: boolean;
    tagBasisProjection?: boolean;
    tagResidualDecomposition?: boolean;
    tagGraphPropagation?: boolean;
    propagationSupport?: boolean;
    embeddingRerank?: boolean;
    nativeTagRetrieval?: boolean;
    tagExpansion?: boolean;
  };
  structural?: {
    enabled?: boolean;
    propagationStructure?: boolean;
    relationExpansion?: boolean;
  };
  propagationHistory?: {
    enabled?: boolean;
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
    minScore?: number;
    maxResults?: number;
    maxContentLength?: number;
  };
}

export type RetrievalPlanInput = Omit<RetrievalPlan, "strategy"> & {
  strategy?: RetrievalStrategy;
};

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
  allowOutOfRange = false,
): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (!allowOutOfRange && (value < min || value > max)) ||
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

function assertCoreSection(
  value: unknown,
  path: "associative" | "structural",
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const section = assertRecord(value, path);
  const allowed =
    path === "associative"
      ? [
          "enabled",
          "tagBasisProjection",
          "tagResidualDecomposition",
          "tagGraphPropagation",
          "propagationSupport",
          "embeddingRerank",
          "nativeTagRetrieval",
          "tagExpansion",
        ]
      : ["enabled", "propagationStructure", "relationExpansion"];
  assertKnownKeys(section, path, allowed);
  for (const key of allowed) assertBoolean(section[key], `${path}.${key}`);
  return section;
}

function assertStrategy(value: unknown): void {
  if (
    value !== undefined &&
    (typeof value !== "string" ||
      !["auto", "semantic", "associative", "structural"].includes(value))
  ) {
    throw new TypeError(
      `Unknown retrieval strategy: ${String(
        typeof value === "string" ? value : JSON.stringify(value),
      )}`,
    );
  }
}

/** Validate a plan before it reaches a pipeline or persisted config. */
export function assertValidRetrievalPlanInput(input?: RetrievalPlanInput | null): void {
  if (input == null) return;
  const source = assertRecord(input, "plan");
  assertKnownKeys(source, "plan", [
    "strategy",
    "associative",
    "structural",
    "propagationHistory",
    "filters",
    "externalRerank",
    "expansion",
    "postprocess",
  ]);
  assertStrategy(source.strategy);
  assertCoreSection(source.associative, "associative");
  assertCoreSection(source.structural, "structural");

  if (source.propagationHistory !== undefined) {
    const history = assertRecord(source.propagationHistory, "propagationHistory");
    assertKnownKeys(history, "propagationHistory", ["enabled"]);
    assertBoolean(history.enabled, "propagationHistory.enabled");
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
    for (const key of ["recordedAfter", "recordedBefore"]) {
      const value = filters[key];
      if (
        value !== undefined &&
        !(
          (typeof value === "number" && Number.isFinite(value)) ||
          typeof value === "string"
        )
      ) {
        invalidPlanParameter(`filters.${key}`, "expected a finite number or string");
      }
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
    for (const key of ["related", "sameDocument", "fullDocument", "associate"])
      assertBoolean(expansion[key], `expansion.${key}`);
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
    for (const key of ["timeDecay", "dedupe", "truncate"])
      assertBoolean(postprocess[key], `postprocess.${key}`);
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

function mergeSections(
  base: RetrievalPlan,
  patch: RetrievalPlanInput,
): RetrievalPlanInput {
  return {
    strategy: patch.strategy ?? base.strategy,
    associative: mergeRecord(base.associative, patch.associative),
    structural: mergeRecord(base.structural, patch.structural),
    propagationHistory: mergeRecord(base.propagationHistory, patch.propagationHistory),
    filters: mergeFilters(base.filters, patch.filters),
    externalRerank: mergeRecord(base.externalRerank, patch.externalRerank),
    expansion: mergeRecord(base.expansion, patch.expansion),
    postprocess: mergeRecord(base.postprocess, patch.postprocess),
  };
}

/** Merge a query override over an engine default without mutating either input. */
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
  return mergeSections(coreBase, {
    ...patch,
    strategy,
    filters: mergeFilters(base.filters, patch.filters),
    externalRerank: mergeRecord(base.externalRerank, patch.externalRerank),
    expansion: mergeRecord(base.expansion, patch.expansion),
    postprocess: mergeRecord(base.postprocess, patch.postprocess),
  });
}

function cloneMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneMetadataValue);
  if (!isRecord(value)) return value;
  const clone: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value))
    clone[key] = cloneMetadataValue(nested);
  return clone;
}

function cloneMetadata(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return value === undefined
    ? undefined
    : (cloneMetadataValue(value) as Record<string, unknown>);
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

/** Normalize and detach a public retrieval plan. */
export function normalizeRetrievalPlan(
  input?: RetrievalPlanInput | null,
): RetrievalPlan {
  if (input != null) {
    const source = input as unknown as Record<string, unknown>;
    if (!isRecord(source)) invalidPlanParameter("plan", "expected an object");
    assertKnownKeys(source, "plan", [
      "strategy",
      "associative",
      "structural",
      "propagationHistory",
      "filters",
      "externalRerank",
      "expansion",
      "postprocess",
    ]);
    assertStrategy(source.strategy);
    assertCoreSection(source.associative, "associative");
    assertCoreSection(source.structural, "structural");
  }
  const source = input ?? { strategy: "auto" as const };
  const strategy = source.strategy ?? "auto";
  const associativeInput = source.associative ?? {};
  const structuralInput = source.structural ?? {};
  const associativeEnabled =
    associativeInput.enabled ??
    (strategy === "associative" || strategy === "structural");
  const structuralEnabled = structuralInput.enabled ?? strategy === "structural";
  const filters = source.filters;
  const externalRerank = source.externalRerank ?? {};
  const expansion = source.expansion ?? {};
  const postprocess = source.postprocess ?? {};

  return {
    strategy,
    associative: {
      enabled: associativeEnabled,
      tagBasisProjection: associativeInput.tagBasisProjection ?? associativeEnabled,
      tagResidualDecomposition:
        associativeInput.tagResidualDecomposition ?? associativeEnabled,
      tagGraphPropagation: associativeInput.tagGraphPropagation ?? associativeEnabled,
      propagationSupport: associativeInput.propagationSupport ?? associativeEnabled,
      embeddingRerank: associativeInput.embeddingRerank ?? false,
      nativeTagRetrieval: associativeInput.nativeTagRetrieval ?? false,
      tagExpansion: associativeInput.tagExpansion ?? false,
    },
    structural: {
      enabled: structuralEnabled,
      propagationStructure: structuralInput.propagationStructure ?? structuralEnabled,
      relationExpansion: structuralInput.relationExpansion ?? false,
    },
    propagationHistory: {
      enabled: source.propagationHistory?.enabled ?? false,
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

/** Convert a normalized public plan into per-run canonical config gates. */
export function applyRetrievalPlan(input: RetrievalPlan): MemoryConfigOverrides {
  const plan = normalizeRetrievalPlan(input);
  const associative = plan.associative ?? {};
  const structural = plan.structural ?? {};
  const filters = plan.filters;
  const sameDocumentExpansionEnabled = plan.expansion?.sameDocument === true;
  const fullDocumentExpansionEnabled = plan.expansion?.fullDocument === true;
  const associatorEnabled = plan.expansion?.associate === true;
  const relationExpansionEnabled =
    plan.expansion?.related === true || structural.relationExpansion === true;
  const config: MemoryConfigOverrides = {
    retrievalPlan: plan,
    tagBasisProjectionEnabled: associative.tagBasisProjection === true,
    tagResidualDecompositionEnabled: associative.tagResidualDecomposition === true,
    tagGraphPropagationEnabled: associative.tagGraphPropagation === true,
    propagationSupportRerankEnabled: associative.propagationSupport === true,
    propagationStructureRerankEnabled: structural.propagationStructure === true,
    propagationHistoryEnabled: plan.propagationHistory?.enabled === true,
    embeddingRerankEnabled: associative.embeddingRerank === true,
    nativeTagRetrievalEnabled:
      associative.nativeTagRetrieval === true || structural.enabled === true,
    tagExpansionEnabled: associative.tagExpansion === true,
    relationExpansionEnabled,
    relationMaxHops: plan.expansion?.maxHops ?? 1,
    relationMaxAdded: plan.expansion?.maxAdded ?? 50,
    relationExpansionSeeds: 3,
    expansionEnabled: sameDocumentExpansionEnabled || fullDocumentExpansionEnabled,
    fullDocumentExpansionEnabled,
    associatorEnabled,
    expandCount: plan.expansion?.maxAdded ?? 50,
    externalRerankEnabled: plan.externalRerank?.enabled === true,
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
  if (filters && filters.spaces !== undefined) config.indexNames = [...filters.spaces];
  return config;
}

function deepFreeze(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const nested of Object.values(value as Record<string, unknown>))
    deepFreeze(nested);
  return Object.freeze(value);
}

export function freezeRetrievalPlan(plan: RetrievalPlan): RetrievalPlan {
  return deepFreeze(plan) as RetrievalPlan;
}
