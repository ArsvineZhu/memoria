import type { FileRow } from "../../types/metadata.js";
import type { MemoryConfigOverrides } from "../../types/config.js";
import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";
import type { UnknownRecord } from "../../types/common.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";
import { relationDocumentKey } from "../../retrieval/relation-graph.js";
import { parseRetrievalDate } from "../../retrieval/retrieval-date.js";

interface RetrievalFilters {
  spaces?: readonly string[];
  documentIds?: readonly string[];
  recordedAfter?: number | string;
  recordedBefore?: number | string;
  metadata?: Record<string, unknown>;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseMetadata(value: unknown): UnknownRecord {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeFilterDates(filters: RetrievalFilters | null): {
  filters: RetrievalFilters | null;
  invalid: boolean;
} {
  if (!filters) return { filters: null, invalid: false };
  const after = parseRetrievalDate(filters.recordedAfter);
  const before = parseRetrievalDate(filters.recordedBefore);
  if (
    (filters.recordedAfter !== undefined && after === null) ||
    (filters.recordedBefore !== undefined && before === null) ||
    (after !== null && before !== null && after > before)
  ) {
    return { filters: null, invalid: true };
  }
  return {
    filters: {
      ...filters,
      recordedAfter: after === null ? undefined : after,
      recordedBefore: before === null ? undefined : before,
    },
    invalid: false,
  };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(right, key) &&
          deepEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

function readPath(record: UnknownRecord, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    return isRecord(current) ? current[key] : undefined;
  }, record);
}

function matchesMetadata(file: FileRow, expected: Record<string, unknown>): boolean {
  const metadata = parseMetadata(file.metadata_json);
  return Object.entries(expected).every(([key, value]) => {
    const actual = readPath(metadata, key);
    if (Array.isArray(actual) && !Array.isArray(value))
      return actual.some((item) => deepEqual(item, value));
    return deepEqual(actual, value);
  });
}

function resolveFilters(
  input: PipelineData,
  config: MemoryConfigOverrides,
): RetrievalFilters | null {
  const candidate =
    input.retrievalFilters ?? config.retrievalFilters ?? input.retrievalPlan;
  if (!isRecord(candidate)) return null;
  const nested = isRecord(candidate.filters) ? candidate.filters : candidate;
  return nested as RetrievalFilters;
}

/** Resolve non-index filters into a fail-closed chunk-id set. */
class RetrievalFilterResolverStage extends Stage {
  constructor() {
    super();
    this.name = "retrievalFilterResolver";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<PipelineData> {
    const info = input || {};
    const rawFilters = resolveFilters(info, ctx.config || {});
    const normalized = normalizeFilterDates(rawFilters);
    if (normalized.invalid) {
      return {
        ...info,
        retrievalFilters: rawFilters || undefined,
        allowedChunkIds: new Set<number>(),
        allowedDocumentKeys: new Set<string>(),
        retrievalFilter: { matchedChunks: 0, invalid: true },
      };
    }
    const filters = normalized.filters;
    const needsChunkResolution = !!(
      filters &&
      (filters.spaces !== undefined ||
        filters.documentIds !== undefined ||
        filters.recordedAfter !== undefined ||
        filters.recordedBefore !== undefined ||
        filters.metadata !== undefined)
    );
    if (!needsChunkResolution)
      return { ...info, retrievalFilters: filters || undefined };

    const store = ctx.metadataStore;
    if (!store) {
      return {
        ...info,
        allowedChunkIds: new Set<number>(),
        allowedDocumentKeys: new Set<string>(),
        retrievalFilter: { matchedChunks: 0, unavailable: true },
      };
    }

    const documentIds = filters?.documentIds
      ? new Set(filters.documentIds.map((id) => String(id)))
      : null;
    // A plan filter is a hard constraint, not a replacement for the caller's
    // broader resolved scope. The vector stages may search the broader scope,
    // but only chunks in this set can survive and reach any expansion stage.
    const allowedSpaces =
      filters?.spaces !== undefined
        ? new Set(filters.spaces.map((name) => String(name)))
        : Array.isArray(info.resolvedIndexNames)
          ? new Set(info.resolvedIndexNames.map((name) => String(name)))
          : null;

    if (typeof store.resolveRetrievalScope === "function") {
      try {
        const resolved = await store.resolveRetrievalScope(
          filters,
          allowedSpaces ? [...allowedSpaces] : undefined,
        );
        return {
          ...info,
          retrievalFilters: filters,
          allowedChunkIds: new Set(resolved.allowedChunkIds),
          allowedDocumentKeys: new Set(resolved.allowedDocumentKeys),
          retrievalFilter: {
            matchedChunks: resolved.allowedChunkIds.length,
            requestedDocumentIds: documentIds?.size || 0,
            hasTimeRange:
              filters.recordedAfter !== undefined ||
              filters.recordedBefore !== undefined,
            hasMetadata: !!filters.metadata,
          },
        };
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Metadata store failed while resolving retrieval filters.",
          { retryable: true },
        );
      }
    }

    if (
      typeof store.getAllChunks !== "function" ||
      typeof store.getFileByChunkId !== "function"
    ) {
      return {
        ...info,
        retrievalFilters: filters,
        allowedChunkIds: new Set<number>(),
        allowedDocumentKeys: new Set<string>(),
        retrievalFilter: { matchedChunks: 0, unavailable: true },
      };
    }
    const after = parseRetrievalDate(filters?.recordedAfter);
    const before = parseRetrievalDate(filters?.recordedBefore);
    const allowed = new Set<number>();
    const allowedDocumentKeys = new Set<string>();
    let chunks;
    try {
      chunks = await store.getAllChunks();
      for (const chunk of chunks || []) {
        const chunkId = Number(chunk.id);
        if (!Number.isFinite(chunkId)) continue;
        const file = await store.getFileByChunkId(chunkId);
        if (!file) continue;
        const space = String(file.space || "Root");
        if (allowedSpaces && !allowedSpaces.has(space)) continue;
        if (documentIds && !documentIds.has(String(file.document_id ?? ""))) continue;
        const recorded = Number(file.recorded_at);
        if (after !== null && (!Number.isFinite(recorded) || recorded < after))
          continue;
        if (before !== null && (!Number.isFinite(recorded) || recorded > before))
          continue;
        if (filters?.metadata && !matchesMetadata(file, filters.metadata)) continue;
        allowed.add(chunkId);
        allowedDocumentKeys.add(relationDocumentKey(file));
      }
    } catch (error) {
      throw asMemoriaError(
        error,
        "persistence",
        "Metadata store failed while resolving retrieval filters.",
        { retryable: true },
      );
    }

    return {
      ...info,
      retrievalFilters: filters,
      allowedChunkIds: allowed,
      allowedDocumentKeys,
      retrievalFilter: {
        matchedChunks: allowed.size,
        requestedDocumentIds: documentIds?.size || 0,
        hasTimeRange: after !== null || before !== null,
        hasMetadata: !!filters?.metadata,
      },
    };
  }
}

export default RetrievalFilterResolverStage;
