import type { MemoryConfigOverrides } from "../types/config.js";
import type { RetrievalPlan, RetrievalPlanInput } from "./retrieval-plan-types.js";
import {
  assertRetrievalPlanShape,
  assertValidRetrievalPlanInput,
} from "./retrieval-plan-validation.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  for (const [key, nested] of Object.entries(value)) {
    clone[key] = cloneMetadataValue(nested);
  }
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
    assertRetrievalPlanShape(input);
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
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

export function freezeRetrievalPlan(plan: RetrievalPlan): RetrievalPlan {
  return deepFreeze(plan) as RetrievalPlan;
}
