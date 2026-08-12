import type { UnknownRecord, Vector } from "../types/common.js";
import {
  candidateCompleteness,
  getChunkId,
  getExactIdentities,
  getScore,
  getSourcePriority,
  isPreferredCandidate,
  normalizeText,
} from "./result-deduplicator-identities.js";
import {
  compareCandidates,
  compareOutputOrder,
  semanticDeduplicate,
} from "./result-deduplicator-ranking.js";
import {
  cosineSimilarity,
  getCandidateVector,
  hydrateMissingVectors,
  toValidVector,
} from "./result-deduplicator-vectors.js";
import {
  DEFAULT_DEDUPLICATOR_CONFIG,
  type Candidate,
  type ChunkVectorLoader,
  type DeduplicateOptions,
  type DeduplicatorConfig,
  type RankedCandidate,
} from "./result-deduplicator-types.js";

export type {
  Candidate,
  ChunkVectorLoader,
  DeduplicateOptions,
  DeduplicatorConfig,
  RankedCandidate,
} from "./result-deduplicator-types.js";

/** Stable facade over exact-identity and semantic candidate deduplication. */
class ResultDeduplicator {
  loadVector?: ChunkVectorLoader;
  config: DeduplicatorConfig;

  constructor(
    loadVector?: ChunkVectorLoader,
    config: Partial<DeduplicatorConfig> = {},
  ) {
    this.loadVector = loadVector;
    this.config = {
      ...DEFAULT_DEDUPLICATOR_CONFIG,
      ...config,
      sourcePriority: {
        ...DEFAULT_DEDUPLICATOR_CONFIG.sourcePriority,
        ...config.sourcePriority,
      },
    };
  }

  updateConfig(config: Partial<DeduplicatorConfig> & UnknownRecord = {}): void {
    if (!config || typeof config !== "object" || Array.isArray(config)) return;
    const next = { ...this.config };
    if (Number.isFinite(Number(config.dimension)) && Number(config.dimension) > 0) {
      next.dimension = Math.floor(Number(config.dimension));
    }
    if (Number.isFinite(Number(config.semanticThreshold))) {
      next.semanticThreshold = Math.max(
        -1,
        Math.min(1, Number(config.semanticThreshold)),
      );
    }
    if (Number.isFinite(Number(config.maxResults)) && Number(config.maxResults) > 0) {
      next.maxResults = Math.floor(Number(config.maxResults));
    }
    if (
      Number.isFinite(Number(config.minSemanticCandidates)) &&
      Number(config.minSemanticCandidates) >= 0
    ) {
      next.minSemanticCandidates = Math.floor(Number(config.minSemanticCandidates));
    }
    if (
      config.sourcePriority &&
      typeof config.sourcePriority === "object" &&
      !Array.isArray(config.sourcePriority)
    ) {
      next.sourcePriority = { ...next.sourcePriority, ...config.sourcePriority };
    }
    this.config = next;
  }

  async deduplicate(
    candidates: readonly Candidate[],
    queryVector: Vector | readonly number[] | null = null,
    options: DeduplicateOptions = {},
  ): Promise<Candidate[]> {
    if (!Array.isArray(candidates) || candidates.length === 0) return [];
    const stage = String(options.stage || "candidate");
    const hardDeduplicated = this.hardDeduplicate(candidates);
    const semanticEnabled = options.semantic !== false;
    const maxResults = this._resolveMaxResults(options.maxResults);
    if (
      !semanticEnabled ||
      hardDeduplicated.length < this.config.minSemanticCandidates
    ) {
      return hardDeduplicated.slice(0, maxResults);
    }

    try {
      const hydrated = await this._hydrateMissingVectors(hardDeduplicated);
      const semanticThreshold = this._resolveSemanticThreshold(
        options.semanticThreshold,
      );
      const results = this._semanticDeduplicate(
        hydrated,
        queryVector,
        semanticThreshold,
        maxResults,
      );
      console.log(
        `[ResultDeduplicator] stage=${stage}: ` +
          `${candidates.length} input -> ${hardDeduplicated.length} exact -> ` +
          `${results.length} semantic (threshold=${semanticThreshold.toFixed(3)}).`,
      );
      return results;
    } catch (error) {
      console.warn(
        `[ResultDeduplicator] stage=${stage}: semantic deduplication failed; ` +
          `falling back to exact results: ${error instanceof Error ? error.message : String(error)}`,
      );
      return hardDeduplicated.slice(0, maxResults);
    }
  }

  hardDeduplicate(candidates: readonly Candidate[]): Candidate[] {
    if (!Array.isArray(candidates) || candidates.length === 0) return [];
    const selected: Candidate[] = [];
    const identityOwner = new Map<string, number>();
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (!candidate || typeof candidate !== "object") continue;
      const identities = this._getExactIdentities(candidate);
      if (identities.length === 0) {
        selected.push(candidate);
        continue;
      }

      let existingIndex = -1;
      for (const identity of identities) {
        if (identityOwner.has(identity)) {
          existingIndex = identityOwner.get(identity) ?? -1;
          break;
        }
      }
      if (existingIndex === -1) {
        const nextIndex = selected.length;
        selected.push(candidate);
        for (const identity of identities) identityOwner.set(identity, nextIndex);
        continue;
      }

      const existing = selected[existingIndex];
      if (existing && this._isPreferredCandidate(candidate, existing)) {
        selected[existingIndex] = candidate;
      }
      const mergedIdentities = [
        ...this._getExactIdentities(existing || candidate),
        ...identities,
      ];
      for (const identity of mergedIdentities)
        identityOwner.set(identity, existingIndex);
    }
    return selected;
  }

  _semanticDeduplicate(
    candidates: readonly Candidate[],
    queryVector: Vector | readonly number[] | null,
    threshold: number,
    maxResults: number,
  ): Candidate[] {
    return semanticDeduplicate(
      candidates,
      queryVector,
      threshold,
      maxResults,
      this.config,
    );
  }

  _hydrateMissingVectors(candidates: readonly Candidate[]): Promise<Candidate[]> {
    return hydrateMissingVectors(candidates, this.loadVector, this.config.dimension);
  }

  _getExactIdentities(candidate: Candidate): string[] {
    return getExactIdentities(candidate);
  }

  _isPreferredCandidate(candidate: Candidate, existing: Candidate): boolean {
    return isPreferredCandidate(candidate, existing, this.config);
  }

  _compareCandidates(
    a: RankedCandidate,
    b: RankedCandidate,
    queryVector: Vector | null,
  ): number {
    return compareCandidates(a, b, queryVector, this.config);
  }

  _compareOutputOrder(a: RankedCandidate, b: RankedCandidate): number {
    return compareOutputOrder(a, b, this.config);
  }

  _getSourcePriority(candidate: Candidate): number {
    return getSourcePriority(candidate, this.config);
  }

  _getScore(candidate: Candidate): number {
    return getScore(candidate);
  }

  _candidateCompleteness(candidate: Candidate): number {
    return candidateCompleteness(candidate);
  }

  _getChunkId(candidate: Candidate): number | null {
    return getChunkId(candidate);
  }

  _getCandidateVector(candidate: Candidate): Vector | null {
    return getCandidateVector(candidate, this.config.dimension);
  }

  _toValidVector(value: unknown): Vector | null {
    return toValidVector(value, this.config.dimension);
  }

  _normalizeText(value: unknown): string {
    return normalizeText(value);
  }

  _resolveSemanticThreshold(value: unknown): number {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(-1, Math.min(1, parsed));
    return Math.max(-1, Math.min(1, Number(this.config.semanticThreshold) || 0.92));
  }

  _resolveMaxResults(value: unknown): number {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
    const configured = Number(this.config.maxResults);
    return Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : Number.MAX_SAFE_INTEGER;
  }

  _cosineSimilarity(v1: Vector | null, v2: Vector | null): number {
    return cosineSimilarity(v1, v2);
  }
}

export default ResultDeduplicator;
