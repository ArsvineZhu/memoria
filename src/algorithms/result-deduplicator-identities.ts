import type { SourcePriority } from "../types/common.js";
import type { Candidate, DeduplicatorConfig } from "./result-deduplicator-types.js";

export function getChunkId(candidate: Candidate): number | null {
  const value = candidate?.chunkId ?? candidate?.id ?? candidate?.label;
  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isSafeInteger(converted) && converted > 0 ? converted : null;
  }
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

export function normalizeText(value: unknown): string {
  return (typeof value === "string" ? value : "")
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .toLowerCase();
}

export function getExactIdentities(candidate: Candidate): string[] {
  const identities: string[] = [];
  const chunkId = getChunkId(candidate);
  if (chunkId !== null) identities.push(`chunk:${chunkId}`);

  const normalizedText = normalizeText(candidate.text ?? candidate.content);
  if (normalizedText) identities.push(`text:${normalizedText}`);

  const fullPath = (
    typeof candidate.fullPath === "string"
      ? candidate.fullPath
      : typeof candidate.sourceFile === "string"
        ? candidate.sourceFile
        : typeof candidate._expandedFilePath === "string"
          ? candidate._expandedFilePath
          : ""
  )
    .trim()
    .replace(/\\/g, "/")
    .toLowerCase();
  const chunkIndex = candidate.chunkIndex ?? candidate.chunk_index ?? candidate.offset;
  const chunkIndexText =
    typeof chunkIndex === "string" || typeof chunkIndex === "number"
      ? String(chunkIndex)
      : "";
  if (fullPath && chunkIndexText) {
    identities.push(`path-chunk:${fullPath}:${chunkIndexText}`);
  }

  return identities;
}

export function getSourcePriority(
  candidate: Candidate,
  config: Pick<DeduplicatorConfig, "sourcePriority">,
): number {
  const source = String(candidate?.source || "unknown").toLowerCase();
  const canonicalSource =
    source === "vector" || source === "hybrid"
      ? "semantic"
      : source === "expansion"
        ? "associate"
        : source;
  const configured = Number(
    config.sourcePriority?.[canonicalSource as keyof typeof config.sourcePriority],
  );
  if (Number.isFinite(configured)) return configured;
  if (source.startsWith("bm25")) {
    const bm25Priority = Number(config.sourcePriority?.bm25Body);
    return Number.isFinite(bm25Priority) ? bm25Priority : 40;
  }
  return Number(config.sourcePriority?.unknown) || 0;
}

export function getScore(candidate: Candidate): number {
  const score = Number(
    candidate?.rerank_score ??
      candidate?.rrf_score ??
      candidate?.score ??
      candidate?.original_score ??
      0,
  );
  return Number.isFinite(score) ? score : 0;
}

export function candidateCompleteness(candidate: Candidate): number {
  let score = 0;
  if (getChunkId(candidate) !== null) score += 4;
  if (candidate.fullPath || candidate.sourceFile) score += 2;
  if (candidate.text || candidate.content) score += 2;
  if (candidate.vector || candidate._vector) score += 1;
  if (candidate.matchedTags) score += 1;
  return score;
}

export function isPreferredCandidate(
  candidate: Candidate,
  existing: Candidate,
  config: Pick<DeduplicatorConfig, "sourcePriority">,
): boolean {
  const candidatePriority = getSourcePriority(candidate, config);
  const existingPriority = getSourcePriority(existing, config);
  if (candidatePriority !== existingPriority) {
    return candidatePriority > existingPriority;
  }

  const candidateScore = getScore(candidate);
  const existingScore = getScore(existing);
  if (candidateScore !== existingScore) return candidateScore > existingScore;

  return candidateCompleteness(candidate) > candidateCompleteness(existing);
}

export type { SourcePriority };
