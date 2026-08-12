import type {
  ChunkCandidate,
  PropagationSupportData,
  MemoryConfigOverrides,
  PipelineContextLike,
  PipelineData,
} from "../../types.js";

import Stage from "../../core/stage.js";
import { createTagRetrievalRuntimeFacade } from "../../native/tag-retrieval-runtime.js";
import { asMemoriaError } from "../../errors.js";
import {
  ensureTagRetrievalArtifact,
  getTagRetrievalIndex,
  nativeDatabasePath,
  readRecord,
} from "../../native/tag-graph-artifact-runtime.js";

const DEFAULT_ALPHA = 0.3;
const DEFAULT_MIN_SUPPORT_SAMPLES = 4;
type NativePropagationSupportFailure =
  "backend_unavailable" | "artifact_unavailable" | "invalid_result";

type ScoredCandidate = {
  candidate: ChunkCandidate;
  chunkId: number;
  originalScore: number;
  supportScore: number;
  hitCount: number;
};

/**
 * Re-ranks retrieved chunks against the tag activation distribution emitted by TagGraphPropagation.
 * The stage only changes ordering and scores; it never changes the candidate
 * pool size or the public SearchResult shape.
 */
class PropagationSupportRerankerStage extends Stage {
  constructor() {
    super();
    this.name = "propagationSupportReranker";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "mergedCandidates" | "propagationSupport"> & {
      mergedCandidates: ChunkCandidate[];
      propagationSupport?: PropagationSupportData;
      propagationSupportSkipped?: boolean;
    }
  > {
    let info = input || {};
    const candidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];
    const config = ctx.config || {};
    const alpha = this._alpha(config);
    const minSupportSamples = this._minSupportSamples(config);

    if (config.propagationSupportRerankEnabled !== true) {
      return {
        ...info,
        mergedCandidates: candidates,
        propagationSupportSkipped: true,
      };
    }

    if (
      config.nativeTagRetrievalEnabled === true &&
      info.tagRetrievalSkipped === false
    ) {
      const native = await this._nativeRerank(info, ctx, alpha, minSupportSamples);
      if (native.output) {
        return {
          ...native.output,
          mergedCandidates: (Array.isArray(native.output.mergedCandidates)
            ? native.output.mergedCandidates
            : candidates) as ChunkCandidate[],
        };
      }
      if (native.reason) {
        info = {
          ...info,
          propagationSupportNativeSkipped: true,
          propagationSupportNativeSkipReason: native.reason,
          propagationSupportNativeFailure: native.failure,
        };
      }
    }

    const activations = info.tagGraphPropagation?.activations;
    if (
      !(activations instanceof Map) ||
      activations.size === 0 ||
      candidates.length === 0
    ) {
      return {
        ...info,
        mergedCandidates: candidates,
        propagationSupport: this._emptyData(alpha, minSupportSamples),
        propagationSupportSkipped: true,
      };
    }

    const tagCache = new Map<string, number | null>();
    const scored: ScoredCandidate[] = [];
    let degradedCount = 0;

    for (const candidate of candidates) {
      const chunkId = Number(candidate && candidate.chunkId);
      const originalScore = this._score(candidate && candidate.score);
      const tagIds = await this._resolveTagIds(candidate, ctx, tagCache);
      let hitCount = 0;
      let totalActivation = 0;
      const seen = new Set<number>();

      for (const tagId of tagIds) {
        if (seen.has(tagId) || !activations.has(tagId)) continue;
        seen.add(tagId);
        hitCount += 1;
        const activation = Number(activations.get(tagId));
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

    if (!(maxSupportScore > 0)) {
      return {
        ...info,
        mergedCandidates: candidates,
        propagationSupport: {
          schema: "tag-association-transition-v1",
          algorithmVersion: "tag-association-transition-typescript",
          alpha,
          minSupportSamples,
          appliedCount: 0,
          degradedCount,
          scores: observedScores,
        },
        propagationSupportSkipped: true,
      };
    }

    const appliedCount = scored.reduce(
      (count, item) => count + (item.supportScore > 0 ? 1 : 0),
      0,
    );
    const finalByChunk = new Map<number, number>();
    for (const observed of observedScores) {
      const normalized = observed.normalizedSupportScore;
      const finalScore =
        observed.supportScore > 0
          ? (1 - alpha) * observed.originalScore + alpha * normalized
          : observed.originalScore;
      observed.finalScore = finalScore;
      if (Number.isFinite(observed.chunkId))
        finalByChunk.set(observed.chunkId, finalScore);
    }

    const reranked = scored.map((item) => ({
      ...item.candidate,
      score: finalByChunk.get(item.chunkId) ?? item.originalScore,
    }));
    reranked.sort(
      (left, right) =>
        this._score(right.score) - this._score(left.score) ||
        this._compareChunkIds(left.chunkId, right.chunkId),
    );

    return {
      ...info,
      mergedCandidates: reranked,
      propagationSupport: {
        schema: "tag-association-transition-v1",
        algorithmVersion: "tag-association-transition-typescript",
        alpha,
        minSupportSamples,
        appliedCount,
        degradedCount,
        scores: observedScores,
      },
    };
  }

  private async _nativeRerank(
    info: PipelineData,
    ctx: PipelineContextLike,
    alpha: number,
    minSupportSamples: number,
  ): Promise<{
    output?: PipelineData;
    reason?: NativePropagationSupportFailure;
    failure?: NativePropagationSupportFailure;
  }> {
    const index = getTagRetrievalIndex(ctx);
    const dbPath = nativeDatabasePath(ctx);
    if (!index || !dbPath || typeof index.rerankByPropagationSupport !== "function") {
      return {
        reason: "backend_unavailable",
        failure: "backend_unavailable",
      };
    }

    let artifact = readRecord(info.tagGraphArtifact);
    if (typeof artifact.artifactSig !== "string" || !artifact.artifactSig) {
      const built = await ensureTagRetrievalArtifact(ctx, index);
      if (!built.state) {
        return {
          reason:
            built.failure === "invalid_result"
              ? "invalid_result"
              : "artifact_unavailable",
          failure:
            built.failure === "invalid_result"
              ? "invalid_result"
              : "artifact_unavailable",
        };
      }
      artifact = built.state as unknown as Record<string, unknown>;
    }

    const tagRetrieval = readRecord(info.tagRetrieval);
    const candidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];
    const originalById = new Map(
      candidates.map((candidate) => [Number(candidate.chunkId), candidate]),
    );
    const options =
      info.options && typeof info.options === "object" ? info.options : {};
    const nativeConfig = {};
    const observationHandle =
      typeof tagRetrieval.observationHandle === "string"
        ? tagRetrieval.observationHandle
        : undefined;
    const originalQuery = info.nativeQueryVector ?? info.queryVector;
    const enhancedQuery = info.queryVector;
    const payload: Record<string, unknown> = {
      dimension: Number(ctx.config.dimension),
      observationHandle,
      queryRetrievalState: {
        tagBasisProjection: info.tagBasisProjection || {},
        tagResidualDecomposition: info.tagResidualDecomposition || {},
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
          score: this._score(candidate.score),
        }))
        .filter((candidate) => Number.isFinite(candidate.id) && candidate.id > 0),
      config: {
        ...nativeConfig,
        alpha,
        minSupportSamples,
      },
    };
    if (!observationHandle) {
      payload.observation = tagRetrieval.observation || {};
      payload.originalQueryVector = this._vectorArray(originalQuery);
      payload.enhancedQueryVector = this._vectorArray(enhancedQuery);
    }

    try {
      const runtime = createTagRetrievalRuntimeFacade(index, dbPath);
      const raw = await runtime.rerankByPropagationSupport(
        JSON.stringify(payload),
        String(artifact.artifactSig),
      );
      const output = this._nativeRecord(raw);
      const nativeResults =
        output && Array.isArray(output.results) ? output.results : null;
      if (!output || !nativeResults) {
        return { reason: "invalid_result", failure: "invalid_result" };
      }

      const ranked: ChunkCandidate[] = [];
      const rankedIds = new Set<number>();
      const scores: PropagationSupportData["scores"] = [];
      for (const rawResult of nativeResults) {
        const result = readRecord(rawResult);
        const chunkId = Number(result.id ?? result.chunkId);
        if (!Number.isFinite(chunkId)) continue;
        const original = originalById.get(chunkId);
        const originalScore = this._finiteOr(
          result.originalKnnScore,
          this._score(original?.score),
        );
        const supportScore = this._finiteOr(result.supportScore, 0);
        const normalizedSupportScore = this._finiteOr(result.normalizedSupportScore, 0);
        const finalScore = this._finiteOr(result.score, originalScore);
        const hitCount = Math.max(
          0,
          Math.round(
            this._finiteOr(
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
          normalizedSupportScore: normalizedSupportScore,
          supportBonus: this._finiteOr(result.supportBonus, 0),
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
          originalScore: this._score(candidate.score),
          supportScore: 0,
          normalizedSupportScore: 0,
          finalScore: this._score(candidate.score),
          hitCount: 0,
        });
      }

      const appliedCount = scores.filter((score) => score.supportScore > 0).length;
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
      return {
        reason: "backend_unavailable",
        failure: "backend_unavailable",
      };
    }
  }

  private _nativeRecord(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
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

  private _vectorArray(value: unknown): number[] {
    if (!Array.isArray(value) && !(value instanceof Float32Array)) return [];
    return Array.from(value as ArrayLike<unknown>, (item) => this._score(item));
  }

  private _finiteOr(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private async _resolveTagIds(
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
      const directId = this._tagId(rawTag);
      if (directId !== null) {
        ids.push(directId);
        continue;
      }
      const name = this._tagName(rawTag);
      if (!name || !metadataStore || typeof metadataStore.getTagByName !== "function") {
        continue;
      }
      let tagId = cache.get(name);
      if (tagId === undefined && !cache.has(name)) {
        try {
          const tag = await metadataStore.getTagByName(name);
          tagId = Number.isFinite(Number(tag?.id)) ? Number(tag!.id) : null;
        } catch (error) {
          throw asMemoriaError(
            error,
            "persistence",
            "Metadata store failed while resolving a propagationSupport tag.",
            { retryable: true },
          );
        }
        cache.set(name, tagId);
      }
      if (tagId !== null && tagId !== undefined) ids.push(tagId);
    }
    return ids;
  }

  private _tagId(value: unknown): number | null {
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

  private _tagName(value: unknown): string | null {
    if (typeof value === "string") return value.trim() || null;
    if (!value || typeof value !== "object") return null;
    const name = (value as { name?: unknown }).name;
    return typeof name === "string" ? name.trim() || null : null;
  }

  private _alpha(config: MemoryConfigOverrides): number {
    const value = Number(config.supportRerankAlpha);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_ALPHA;
  }

  private _minSupportSamples(config: MemoryConfigOverrides): number {
    const value = Number(config.supportRerankMinSamples);
    return Number.isFinite(value)
      ? Math.max(1, Math.round(value))
      : DEFAULT_MIN_SUPPORT_SAMPLES;
  }

  private _score(value: unknown): number {
    const score = Number(value);
    return Number.isFinite(score) ? score : 0;
  }

  private _compareChunkIds(left: unknown, right: unknown): number {
    const a = Number(left);
    const b = Number(right);
    if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
    if (Number.isFinite(a)) return -1;
    if (Number.isFinite(b)) return 1;
    return 0;
  }

  private _emptyData(alpha: number, minSupportSamples: number): PropagationSupportData {
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
}

export default PropagationSupportRerankerStage;
