import { getVexusIndex } from "../native/vexus-lite.js";
import type { VexusIndex } from "../native/vexus-lite.js";

export interface NativeSearchResult {
  id: number;
  score: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Convert N-API values into the stable public search result shape. */
export function parseNativeSearchResults(value: unknown): NativeSearchResult[] {
  if (!Array.isArray(value)) return [];

  const results: NativeSearchResult[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;

    const rawId = item.id;
    const rawScore = item.score;
    if (
      (typeof rawId !== "number" && typeof rawId !== "bigint") ||
      (typeof rawScore !== "number" && typeof rawScore !== "bigint")
    ) {
      continue;
    }

    const id = Number(rawId);
    const score = Number(rawScore);
    if (Number.isSafeInteger(id) && Number.isFinite(score)) {
      results.push({ id, score });
    }
  }

  return results;
}

/** Create a native index without exposing the generated binding to providers. */
export function createVexusIndex(dimension: number, capacity: number): VexusIndex {
  const VexusIndex = getVexusIndex();
  return new VexusIndex(dimension, capacity);
}

/** Load a native index without exposing the generated binding to providers. */
export function loadVexusIndex(
  indexPath: string,
  dimension: number,
  capacity: number,
): VexusIndex {
  const VexusIndex = getVexusIndex();
  return VexusIndex.load(indexPath, null, dimension, capacity);
}
