import type { Vector, VectorLike } from "../types/common.js";
import type { Candidate, ChunkVectorLoader } from "./result-deduplicator-types.js";
import { getChunkId } from "./result-deduplicator-identities.js";
import { at } from "../utils/numerical.js";

export function toValidVector(value: unknown, dimension: number): Vector | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("length" in value) ||
    typeof value.length !== "number"
  ) {
    return null;
  }
  if (value.length !== dimension) return null;

  const vector =
    value instanceof Float32Array
      ? value
      : new Float32Array(value as ArrayLike<number>);
  let magnitudeSquared = 0;
  for (let i = 0; i < vector.length; i++) {
    const component = at(vector, i, "candidate vector");
    if (!Number.isFinite(component)) return null;
    magnitudeSquared += component * component;
  }
  return magnitudeSquared > 1e-12 ? vector : null;
}

export function getCandidateVector(
  candidate: Candidate,
  dimension: number,
): Vector | null {
  return toValidVector(candidate?.vector || candidate?._vector, dimension);
}

export async function hydrateMissingVectors(
  candidates: readonly Candidate[],
  loadVector: ChunkVectorLoader | undefined,
  dimension: number,
): Promise<Candidate[]> {
  if (!loadVector) return [...candidates];

  const hydrated: Candidate[] = [];
  for (const candidate of candidates) {
    if (getCandidateVector(candidate, dimension)) {
      hydrated.push(candidate);
      continue;
    }

    const chunkId = getChunkId(candidate);
    if (chunkId === null) {
      hydrated.push(candidate);
      continue;
    }

    try {
      const loaded = await loadVector(chunkId);
      const vector = toValidVector(loaded, dimension);
      hydrated.push(vector ? { ...candidate, _vector: vector } : candidate);
    } catch {
      // Semantic hydration is optional; sparse-only candidates remain safe.
      hydrated.push(candidate);
    }
  }
  return hydrated;
}

export function cosineSimilarity(v1: Vector | null, v2: Vector | null): number {
  if (!v1 || !v2 || v1.length !== v2.length) return -1;
  let dot = 0;
  let mag1 = 0;
  let mag2 = 0;
  for (let i = 0; i < v1.length; i++) {
    const left = at(v1, i, "left vector");
    const right = at(v2, i, "right vector");
    dot += left * right;
    mag1 += left * left;
    mag2 += right * right;
  }
  if (mag1 <= 1e-12 || mag2 <= 1e-12) return -1;
  return dot / Math.sqrt(mag1 * mag2);
}

export type { VectorLike };
