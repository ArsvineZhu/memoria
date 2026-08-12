import type { UnknownRecord } from "../types/common.js";
import type { PipelineData } from "../types/pipeline.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function parseNativeJson(value: unknown): UnknownRecord | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function vectorArray(value: unknown): number[] {
  if (!Array.isArray(value) && !(value instanceof Float32Array)) return [];
  return Array.from(value as ArrayLike<unknown>, (item) => {
    const parsed = Number(item);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

export function readNumberList(value: unknown): number[] {
  return vectorArray(value);
}

export function readDistribution(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) return [];
      const id = Number(entry[0]);
      const mass = Number(entry[1]);
      return Number.isFinite(id) && Number.isFinite(mass)
        ? [[id, mass] as [number, number]]
        : [];
    })
    .sort((left, right) => right[1] - left[1] || left[0] - right[0]);
}

export function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function coreTagNames(info: PipelineData): string[] {
  const names = new Set<string>();
  const explicit = Array.isArray(info.coreTags) ? info.coreTags : [];
  for (const tag of explicit) {
    const name = String(tag || "").trim();
    if (name) names.add(name);
  }
  for (const tag of info.tagResidualDecomposition?.levels?.[0]?.tags || []) {
    if (tag && tag.isCore === true && typeof tag.name === "string" && tag.name) {
      names.add(tag.name);
    }
  }
  for (const tag of info.tagGraphPropagation?.ranked || []) {
    if (tag && tag.sourceType === "core" && typeof tag.name === "string" && tag.name) {
      names.add(tag.name);
    }
  }
  return [...names];
}

export function buildNativePipelinePayload(
  info: PipelineData,
  config: UnknownRecord,
  dimension: number,
): UnknownRecord | null {
  const queryVector = vectorArray(info.queryVector);
  if (dimension <= 0 || queryVector.length !== dimension) return null;
  return {
    queryId: typeof info.queryId === "string" ? info.queryId : undefined,
    queryText: typeof info.query === "string" ? info.query : "",
    queryVector,
    coreTags: coreTagNames(info),
    supplementalTags: [],
    config,
  };
}
