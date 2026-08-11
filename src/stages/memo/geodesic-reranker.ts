import type {
  ChunkCandidate,
  GeodesicData,
  MemoryConfigOverrides,
  PipelineContextLike,
  PipelineData,
} from "../../types.js";

import Stage from "../../core/stage.js";
import { createMemoRuntimeFacade } from "../../native/memo-runtime.js";
import { asMemoriaError } from "../../errors.js";
import {
  ensureNativeMemoArtifact,
  getNativeMemoIndex,
  nativeDatabasePath,
  readRecord,
} from "./native-memo-runtime.js";

const DEFAULT_ALPHA = 0.3;
const DEFAULT_MIN_GEO_SAMPLES = 4;

type ScoredCandidate = {
  candidate: ChunkCandidate;
  chunkId: number;
  originalScore: number;
  geoScore: number;
  hitCount: number;
};

/**
 * Re-ranks retrieved chunks against the tag-energy field emitted by TagMemo.
 * The stage only changes ordering and scores; it never changes the candidate
 * pool size or the public SearchResult shape.
 */
class GeodesicRerankerStage extends Stage {
  constructor() {
    super();
    this.name = "geodesicReranker";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "mergedCandidates" | "geodesic"> & {
      mergedCandidates: ChunkCandidate[];
      geodesic?: GeodesicData;
      geodesicSkipped?: boolean;
    }
  > {
    let info = input || {};
    const candidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];
    const config = ctx.config || {};
    const alpha = this._alpha(config);
    const minGeoSamples = this._minGeoSamples(config);

    if (config.geodesicRerankEnabled !== true) {
      return {
        ...info,
        mergedCandidates: candidates,
        geodesicSkipped: true,
      };
    }

    if (config.nativeMemoEnabled === true && info.nativeMemoSkipped === false) {
      const native = await this._nativeRerank(info, ctx, alpha, minGeoSamples);
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
          nativeGeodesicSkipped: true,
          nativeGeodesicSkipReason: native.reason,
        };
      }
    }

    const activations = info.tagMemo?.activations;
    if (
      !(activations instanceof Map) ||
      activations.size === 0 ||
      candidates.length === 0
    ) {
      return {
        ...info,
        mergedCandidates: candidates,
        geodesic: this._emptyData(alpha, minGeoSamples),
        geodesicSkipped: true,
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
      let totalEnergy = 0;
      const seen = new Set<number>();

      for (const tagId of tagIds) {
        if (seen.has(tagId) || !activations.has(tagId)) continue;
        seen.add(tagId);
        hitCount += 1;
        const energy = Number(activations.get(tagId));
        if (Number.isFinite(energy)) totalEnergy += energy;
      }

      const eligible = hitCount >= minGeoSamples && hitCount > 0;
      const geoScore = eligible ? totalEnergy / hitCount : 0;
      if (!eligible) degradedCount += 1;
      scored.push({
        candidate,
        chunkId,
        originalScore,
        geoScore: Number.isFinite(geoScore) ? geoScore : 0,
        hitCount,
      });
    }

    const maxGeoScore = Math.max(
      0,
      ...scored.map((item) => (item.geoScore > 0 ? item.geoScore : 0)),
    );
    const observedScores = scored.map((item) => ({
      chunkId: item.chunkId,
      originalScore: item.originalScore,
      geoScore: item.geoScore,
      normalizedGeoScore:
        maxGeoScore > 0 && item.geoScore > 0 ? item.geoScore / maxGeoScore : 0,
      finalScore: item.originalScore,
      hitCount: item.hitCount,
    }));

    if (!(maxGeoScore > 0)) {
      return {
        ...info,
        mergedCandidates: candidates,
        geodesic: {
          version: "ts-v1",
          alpha,
          minGeoSamples,
          appliedCount: 0,
          degradedCount,
          scores: observedScores,
        },
        geodesicSkipped: true,
      };
    }

    const appliedCount = scored.reduce(
      (count, item) => count + (item.geoScore > 0 ? 1 : 0),
      0,
    );
    const finalByChunk = new Map<number, number>();
    for (const observed of observedScores) {
      const normalized = observed.normalizedGeoScore;
      const finalScore =
        observed.geoScore > 0
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
      geodesic: {
        version: "ts-v1",
        alpha,
        minGeoSamples,
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
    minGeoSamples: number,
  ): Promise<{ output?: PipelineData; reason?: string }> {
    const index = getNativeMemoIndex(ctx);
    const dbPath = nativeDatabasePath(ctx);
    if (!index || !dbPath || typeof index.rerankMemoDtsc !== "function") {
      return { reason: "native DTSC reranker is unavailable" };
    }

    let artifact = readRecord(info.nativeMemoArtifact);
    if (typeof artifact.artifactSig !== "string" || !artifact.artifactSig) {
      const built = await ensureNativeMemoArtifact(ctx, index);
      if (!built.state) {
        return { reason: built.reason };
      }
      artifact = built.state as unknown as Record<string, unknown>;
    }

    const nativeMemo = readRecord(info.nativeMemo);
    const candidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];
    const originalById = new Map(
      candidates.map((candidate) => [Number(candidate.chunkId), candidate]),
    );
    const options =
      info.options && typeof info.options === "object" ? info.options : {};
    const configured = ctx.config.nativeGeodesicConfig;
    const nativeConfig =
      configured && typeof configured === "object" && !Array.isArray(configured)
        ? { ...(configured as Record<string, unknown>) }
        : {};
    const observationHandle =
      typeof nativeMemo.observationHandle === "string"
        ? nativeMemo.observationHandle
        : undefined;
    const originalQuery = info.nativeQueryVector ?? info.queryVector;
    const enhancedQuery = info.queryVector;
    const payload: Record<string, unknown> = {
      dimension: Number(ctx.config.dimension),
      observationHandle,
      queryGeometryState: {
        epa: info.epa || {},
        pyramid: info.pyramid || {},
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
        minGeoSamples,
        minFieldTags: nativeConfig.minFieldTags ?? minGeoSamples,
      },
    };
    if (!observationHandle) {
      payload.observation = nativeMemo.observation || {};
      payload.originalQueryVector = this._vectorArray(originalQuery);
      payload.enhancedQueryVector = this._vectorArray(enhancedQuery);
    }

    try {
      const runtime = createMemoRuntimeFacade(index, dbPath);
      const raw = await runtime.rerankDtsc(
        JSON.stringify(payload),
        String(artifact.artifactSig),
      );
      const output = this._nativeRecord(raw);
      const nativeResults =
        output && Array.isArray(output.results) ? output.results : null;
      if (!output || !nativeResults) {
        return { reason: "native DTSC reranker returned invalid JSON" };
      }

      const ranked: ChunkCandidate[] = [];
      const rankedIds = new Set<number>();
      const scores: GeodesicData["scores"] = [];
      for (const rawResult of nativeResults) {
        const result = readRecord(rawResult);
        const chunkId = Number(result.id ?? result.chunkId);
        if (!Number.isFinite(chunkId)) continue;
        const original = originalById.get(chunkId);
        const originalScore = this._finiteOr(
          result.originalKnnScore,
          this._score(original?.score),
        );
        const geoScore = this._finiteOr(result.geoScore, 0);
        const normalizedGeoScore = this._finiteOr(result.normalizedGeo, 0);
        const finalScore = this._finiteOr(result.score, originalScore);
        const hitCount = Math.max(
          0,
          Math.round(this._finiteOr(result.hitCount ?? result.fieldTagCount, 0)),
        );
        ranked.push({
          ...(original || { chunkId, score: originalScore }),
          chunkId,
          score: finalScore,
          originalKnnScore: originalScore,
          geoScore,
          normalizedGeo: normalizedGeoScore,
          geoBonus: this._finiteOr(result.geoBonus, 0),
          nativeGeodesic: result,
        });
        rankedIds.add(chunkId);
        scores.push({
          chunkId,
          originalScore,
          geoScore,
          normalizedGeoScore,
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
          geoScore: 0,
          normalizedGeoScore: 0,
          finalScore: this._score(candidate.score),
          hitCount: 0,
        });
      }

      const appliedCount = scores.filter((score) => score.geoScore > 0).length;
      return {
        output: {
          ...info,
          mergedCandidates: ranked,
          geodesic: {
            version: "rust-dtsc-v1",
            alpha,
            minGeoSamples,
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
          geodesicSkipped: false,
          nativeGeodesic: output,
        },
      };
    } catch (error) {
      return {
        reason:
          error instanceof Error
            ? `native DTSC reranker failed: ${error.message}`
            : String(error),
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
    } catch (_) {
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
          "Metadata store failed while resolving geodesic candidate tags.",
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
          "Metadata store failed while loading geodesic candidate tags.",
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
            "Metadata store failed while resolving a geodesic tag.",
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
    const value = Number(config.geodesicAlpha);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_ALPHA;
  }

  private _minGeoSamples(config: MemoryConfigOverrides): number {
    const value = Number(config.geodesicMinGeoSamples);
    return Number.isFinite(value)
      ? Math.max(1, Math.round(value))
      : DEFAULT_MIN_GEO_SAMPLES;
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

  private _emptyData(alpha: number, minGeoSamples: number): GeodesicData {
    return {
      version: "ts-v1",
      alpha,
      minGeoSamples,
      appliedCount: 0,
      degradedCount: 0,
      scores: [],
    };
  }
}

export default GeodesicRerankerStage;
