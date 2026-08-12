import type { Vector } from "../types/common.js";
import { getScore, getSourcePriority } from "./result-deduplicator-identities.js";
import type {
  Candidate,
  DeduplicatorConfig,
  RankedCandidate,
} from "./result-deduplicator-types.js";
import {
  cosineSimilarity,
  getCandidateVector,
  toValidVector,
} from "./result-deduplicator-vectors.js";

export function semanticDeduplicate(
  candidates: readonly Candidate[],
  queryVector: Vector | readonly number[] | null,
  threshold: number,
  maxResults: number,
  config: Pick<DeduplicatorConfig, "dimension" | "sourcePriority">,
): Candidate[] {
  const query = getCandidateQueryVector(queryVector, config.dimension);
  const ranked = candidates
    .map((candidate: Candidate, index: number): RankedCandidate => ({
      candidate,
      index,
      vector: getCandidateVector(candidate, config.dimension),
    }))
    .sort((a, b) => compareCandidates(a, b, query, config));

  const selected: RankedCandidate[] = [];
  const selectedVectors: Array<Vector | null> = [];
  for (const entry of ranked) {
    if (selected.length >= maxResults) break;
    if (!entry.vector) {
      selected.push(entry);
      selectedVectors.push(null);
      continue;
    }

    let redundant = false;
    for (const selectedVector of selectedVectors) {
      if (!selectedVector) continue;
      if (cosineSimilarity(entry.vector, selectedVector) >= threshold) {
        redundant = true;
        break;
      }
    }
    if (!redundant) {
      selected.push(entry);
      selectedVectors.push(entry.vector);
    }
  }

  return selected
    .sort((a, b) => compareOutputOrder(a, b, config))
    .map((entry) => entry.candidate);
}

export function compareCandidates(
  a: RankedCandidate,
  b: RankedCandidate,
  queryVector: Vector | null,
  config: Pick<DeduplicatorConfig, "sourcePriority">,
): number {
  const aQuerySimilarity =
    queryVector && a.vector ? cosineSimilarity(a.vector, queryVector) : null;
  const bQuerySimilarity =
    queryVector && b.vector ? cosineSimilarity(b.vector, queryVector) : null;
  if (aQuerySimilarity !== null || bQuerySimilarity !== null) {
    const safeA = aQuerySimilarity ?? -Infinity;
    const safeB = bQuerySimilarity ?? -Infinity;
    if (safeA !== safeB) return safeB - safeA;
  }

  const scoreDiff = getScore(b.candidate) - getScore(a.candidate);
  if (scoreDiff !== 0) return scoreDiff;
  const priorityDiff =
    getSourcePriority(b.candidate, config) - getSourcePriority(a.candidate, config);
  if (priorityDiff !== 0) return priorityDiff;
  return a.index - b.index;
}

export function compareOutputOrder(
  a: RankedCandidate,
  b: RankedCandidate,
  config: Pick<DeduplicatorConfig, "sourcePriority">,
): number {
  const priorityDiff =
    getSourcePriority(b.candidate, config) - getSourcePriority(a.candidate, config);
  if (priorityDiff !== 0) return priorityDiff;
  const scoreDiff = getScore(b.candidate) - getScore(a.candidate);
  if (scoreDiff !== 0) return scoreDiff;
  return a.index - b.index;
}

function getCandidateQueryVector(
  value: Vector | readonly number[] | null,
  dimension: number,
): Vector | null {
  return toValidVector(value, dimension);
}
