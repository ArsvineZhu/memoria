import type { ChunkCandidate } from "../../types/documents.js";
import type { PipelineContextLike } from "../../types/pipeline.js";
import type { PropagationSupportData } from "../../types/retrieval.js";
import { asMemoriaError } from "../../errors.js";
import type { ScoredCandidate } from "./propagation-support-types.js";

export function score(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function compareChunkIds(left: unknown, right: unknown): number {
  const a = Number(left);
  const b = Number(right);
  if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
  if (Number.isFinite(a)) return -1;
  if (Number.isFinite(b)) return 1;
  return 0;
}

export async function resolveTagIds(
  candidate: ChunkCandidate,
  ctx: PipelineContextLike,
  cache: Map<string, number | null>,
): Promise<number[]> {
  const metadataStore = ctx.metadataStore;
  let rawTags: readonly unknown[] | null = null;
  if (Array.isArray(candidate.tags)) {
    rawTags = candidate.tags;
  } else {
    if (
      !metadataStore ||
      typeof metadataStore.getFileByChunkId !== "function" ||
      typeof metadataStore.getFileTags !== "function"
    ) {
      return [];
    }
    const chunkId = Number(candidate.chunkId);
    if (!Number.isFinite(chunkId)) return [];
    let file;
    try {
      file = await metadataStore.getFileByChunkId(chunkId);
    } catch (error) {
      throw asMemoriaError(
        error,
        "persistence",
        "Metadata store failed while resolving propagationSupport candidate tags.",
        { retryable: true },
      );
    }
    if (!file) return [];
    let fileTags;
    try {
      fileTags = await metadataStore.getFileTags(file.id);
    } catch (error) {
      throw asMemoriaError(
        error,
        "persistence",
        "Metadata store failed while loading propagationSupport candidate tags.",
        { retryable: true },
      );
    }
    rawTags = Array.isArray(fileTags) ? fileTags : [];
  }

  const ids: number[] = [];
  for (const rawTag of rawTags) {
    const directId = tagId(rawTag);
    if (directId !== null) {
      ids.push(directId);
      continue;
    }
    const name = tagName(rawTag);
    if (!name || !metadataStore || typeof metadataStore.getTagByName !== "function") {
      continue;
    }
    let resolved = cache.get(name);
    if (resolved === undefined && !cache.has(name)) {
      try {
        const tag = await metadataStore.getTagByName(name);
        resolved = Number.isFinite(Number(tag?.id)) ? Number(tag!.id) : null;
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Metadata store failed while resolving a propagationSupport tag.",
          { retryable: true },
        );
      }
      cache.set(name, resolved);
    }
    if (resolved !== null && resolved !== undefined) ids.push(resolved);
  }
  return ids;
}

export function scoreCandidates(
  candidates: readonly ChunkCandidate[],
  activations: Map<number, number>,
  minSupportSamples: number,
  cache: Map<string, number | null>,
  ctx: PipelineContextLike,
): Promise<{
  scored: ScoredCandidate[];
  observedScores: PropagationSupportData["scores"];
  degradedCount: number;
}> {
  return (async () => {
    const scored: ScoredCandidate[] = [];
    let degradedCount = 0;
    for (const candidate of candidates) {
      const chunkId = Number(candidate && candidate.chunkId);
      const originalScore = score(candidate && candidate.score);
      const tagIds = await resolveTagIds(candidate, ctx, cache);
      let hitCount = 0;
      let totalActivation = 0;
      const seen = new Set<number>();
      for (const candidateTagId of tagIds) {
        if (seen.has(candidateTagId) || !activations.has(candidateTagId)) continue;
        seen.add(candidateTagId);
        hitCount += 1;
        const activation = Number(activations.get(candidateTagId));
        if (Number.isFinite(activation)) totalActivation += activation;
      }
      const eligible = hitCount >= minSupportSamples && hitCount > 0;
      const supportScore = eligible ? totalActivation / hitCount : 0;
      if (!eligible) degradedCount += 1;
      scored.push({
        candidate,
        chunkId,
        originalScore,
        supportScore: Number.isFinite(supportScore) ? supportScore : 0,
        hitCount,
      });
    }

    const maxSupportScore = Math.max(
      0,
      ...scored.map((item) => (item.supportScore > 0 ? item.supportScore : 0)),
    );
    const observedScores = scored.map((item) => ({
      chunkId: item.chunkId,
      originalScore: item.originalScore,
      supportScore: item.supportScore,
      normalizedSupportScore:
        maxSupportScore > 0 && item.supportScore > 0
          ? item.supportScore / maxSupportScore
          : 0,
      finalScore: item.originalScore,
      hitCount: item.hitCount,
    }));
    return { scored, observedScores, degradedCount };
  })();
}

export function applySupportScores(
  scored: readonly ScoredCandidate[],
  observedScores: NonNullable<PropagationSupportData["scores"]>,
  alpha: number,
): { reranked: ChunkCandidate[]; appliedCount: number } {
  const finalByChunk = new Map<number, number>();
  let appliedCount = 0;
  for (const observed of observedScores) {
    const normalized = observed.normalizedSupportScore;
    const finalScore =
      observed.supportScore > 0
        ? (1 - alpha) * observed.originalScore + alpha * normalized
        : observed.originalScore;
    observed.finalScore = finalScore;
    if (observed.supportScore > 0) appliedCount += 1;
    if (Number.isFinite(observed.chunkId))
      finalByChunk.set(observed.chunkId, finalScore);
  }
  const reranked = scored.map((item) => ({
    ...item.candidate,
    score: finalByChunk.get(item.chunkId) ?? item.originalScore,
  }));
  reranked.sort(
    (left, right) =>
      score(right.score) - score(left.score) ||
      compareChunkIds(left.chunkId, right.chunkId),
  );
  return { reranked, appliedCount };
}

export function emptySupportData(
  alpha: number,
  minSupportSamples: number,
): PropagationSupportData {
  return {
    schema: "tag-association-transition-v1",
    algorithmVersion: "tag-association-transition-typescript",
    alpha,
    minSupportSamples,
    appliedCount: 0,
    degradedCount: 0,
    scores: [],
  };
}

export function tagId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") {
    const numeric = Number(value);
    return Number.isFinite(numeric) && String(value).trim() !== "" ? numeric : null;
  }
  const row = value as { id?: unknown; tagId?: unknown; tag_id?: unknown };
  for (const raw of [row.tagId, row.tag_id, row.id]) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

export function tagName(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object") return null;
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" ? name.trim() || null : null;
}
