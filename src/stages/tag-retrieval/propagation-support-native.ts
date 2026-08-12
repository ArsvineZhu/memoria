import type { ChunkCandidate } from "../../types/documents.js";
import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";
import type { PropagationSupportData } from "../../types/retrieval.js";
import { createTagRetrievalRuntimeFacade } from "../../native/tag-retrieval-runtime.js";
import {
  ensureTagRetrievalArtifact,
  getTagRetrievalIndex,
  nativeDatabasePath,
  readRecord,
} from "../../native/tag-graph-artifact-runtime.js";
import { score } from "./propagation-support-scoring.js";
import type {
  NativePropagationSupportFailure,
  NativeRerankResult,
} from "./propagation-support-types.js";

export async function rerankNative(
  info: PipelineData,
  ctx: PipelineContextLike,
  alpha: number,
  minSupportSamples: number,
): Promise<NativeRerankResult> {
  const index = getTagRetrievalIndex(ctx);
  const dbPath = nativeDatabasePath(ctx);
  if (!index || !dbPath || typeof index.rerankByPropagationSupport !== "function") {
    return unavailable("backend_unavailable");
  }
  let artifact = readRecord(info.tagGraphArtifact);
  if (typeof artifact.artifactSig !== "string" || !artifact.artifactSig) {
    const built = await ensureTagRetrievalArtifact(ctx, index);
    if (!built.state) {
      return unavailable(
        built.failure === "invalid_result" ? "invalid_result" : "artifact_unavailable",
      );
    }
    artifact = built.state as unknown as Record<string, unknown>;
  }

  const observation = info.tagRetrievalObservation;
  const candidates = Array.isArray(info.mergedCandidates) ? info.mergedCandidates : [];
  const originalById = new Map(
    candidates.map((candidate) => [Number(candidate.chunkId), candidate]),
  );
  const options = info.options && typeof info.options === "object" ? info.options : {};
  const observationHandle = observation?.observationHandle;
  const originalQuery = info.nativeQueryVector ?? info.queryVector;
  const enhancedQuery = info.queryVector;
  const payload: Record<string, unknown> = {
    dimension: Number(ctx.config.dimension),
    observationHandle,
    queryRetrievalState: {
      tagBasisProjection: observation?.basis || {},
      tagResidualDecomposition: observation?.residual || {},
    },
    topK: Math.max(
      1,
      Math.floor(
        Number(
          (options as Record<string, unknown>).topK ??
            ctx.config.topK ??
            candidates.length,
        ) || 1,
      ),
    ),
    candidates: candidates
      .map((candidate) => ({
        id: Number(candidate.chunkId),
        score: score(candidate.score),
      }))
      .filter((candidate) => Number.isFinite(candidate.id) && candidate.id > 0),
    config: { alpha, minSupportSamples },
  };
  if (!observationHandle) {
    payload.observation = observation?.nativeObservation || {};
    payload.originalQueryVector = vectorArray(originalQuery);
    payload.enhancedQueryVector = vectorArray(enhancedQuery);
  }

  try {
    const runtime = createTagRetrievalRuntimeFacade(index, dbPath);
    const raw = await runtime.rerankByPropagationSupport(
      JSON.stringify(payload),
      String(artifact.artifactSig),
    );
    const output = nativeRecord(raw);
    const nativeResults =
      output && Array.isArray(output.results) ? output.results : null;
    if (!output || !nativeResults) return unavailable("invalid_result");

    const ranked: ChunkCandidate[] = [];
    const rankedIds = new Set<number>();
    const scores: PropagationSupportData["scores"] = [];
    for (const rawResult of nativeResults) {
      const result = readRecord(rawResult);
      const chunkId = Number(result.id ?? result.chunkId);
      if (!Number.isFinite(chunkId)) continue;
      const original = originalById.get(chunkId);
      const originalScore = finiteOr(result.originalKnnScore, score(original?.score));
      const supportScore = finiteOr(result.supportScore, 0);
      const normalizedSupportScore = finiteOr(result.normalizedSupportScore, 0);
      const finalScore = finiteOr(result.score, originalScore);
      const hitCount = Math.max(
        0,
        Math.round(
          finiteOr(
            result.hitCount ?? result.supportHitCount ?? result.distributionTagCount,
            0,
          ),
        ),
      );
      ranked.push({
        ...(original || { chunkId, score: originalScore }),
        chunkId,
        score: finalScore,
        originalKnnScore: originalScore,
        supportScore,
        normalizedSupportScore,
        supportBonus: finiteOr(result.supportBonus, 0),
        propagationSupportNative: result,
      });
      rankedIds.add(chunkId);
      scores.push({
        chunkId,
        originalScore,
        supportScore,
        normalizedSupportScore,
        finalScore,
        hitCount,
      });
    }
    for (const candidate of candidates) {
      if (rankedIds.has(Number(candidate.chunkId))) continue;
      ranked.push(candidate);
      scores.push({
        chunkId: Number(candidate.chunkId),
        originalScore: score(candidate.score),
        supportScore: 0,
        normalizedSupportScore: 0,
        finalScore: score(candidate.score),
        hitCount: 0,
      });
    }
    const appliedCount = scores.filter((entry) => entry.supportScore > 0).length;
    return {
      output: {
        ...info,
        mergedCandidates: ranked,
        propagationSupport: {
          alpha,
          minSupportSamples,
          appliedCount,
          degradedCount: Math.max(0, scores.length - appliedCount),
          native: true,
          schema: typeof output.schema === "string" ? output.schema : undefined,
          algorithmVersion:
            typeof output.algorithmVersion === "string"
              ? output.algorithmVersion
              : undefined,
          diagnostics: readRecord(output.diagnostics),
          scores,
        },
        propagationSupportSkipped: false,
        propagationSupportNative: output,
      },
    };
  } catch {
    return unavailable("backend_unavailable");
  }
}

function unavailable(failure: NativePropagationSupportFailure): NativeRerankResult {
  return { reason: failure, failure };
}

function nativeRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function vectorArray(value: unknown): number[] {
  if (!Array.isArray(value) && !(value instanceof Float32Array)) return [];
  return Array.from(value as ArrayLike<unknown>, (item) => score(item));
}

function finiteOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
