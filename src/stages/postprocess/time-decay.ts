import type { ChunkCandidate } from "../../types/documents.js";
import type { MetadataStoreContract } from "../../types/metadata.js";
import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Postprocess stage: recency-based score decay on merged candidates.
 *
 * Each candidate's owning file `recorded_at` age in days is
 * converted to a decay multiplier 0.5 ^ (ageDays / halfLifeDays), following
 * the Memoria/TDB recency formula. Scores are multiplied by the decay;
 * candidates without resolvable recency keep decay = 1.
 *
 * Input: { mergedCandidates: [{ chunkId, score, ... }] }
 * Output: { ..., mergedCandidates: [{ ..., decay }] }
 *
 * Config (ctx.config):
 *   - timeDecayEnabled     gate (default false; opt-in)
 *   - timeDecayHalfLife    score half-life in DAYS (default 90)
 *   - timeDecayNow         epoch-ms clock override (tests/determinism)
 *   - timeDecayUpperBound  recency window in days; older files are clamped
 *                          so the penalty never exceeds 0.5^(bound/halfLife)
 */
class TimeDecayStage extends Stage {
  constructor() {
    super();
    this.name = "timeDecay";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "mergedCandidates"> & { mergedCandidates: ChunkCandidate[] }
  > {
    const info = input || {};
    const config = ctx.config || {};
    const candidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];

    if (config.timeDecayEnabled !== true) {
      return { ...info, mergedCandidates: candidates };
    }

    const halfLifeDays = Number(config.timeDecayHalfLife) || 90;
    const nowMs = Number(config.timeDecayNow) || Date.now();
    const upperBoundDays = Number(config.timeDecayUpperBound);
    const metadataStore = ctx.metadataStore;

    const decayed = [];
    for (const candidate of candidates) {
      let decay = 1;
      try {
        const recordedAt = await this._resolveRecency(candidate, metadataStore);
        if (recordedAt !== null && Number.isFinite(recordedAt)) {
          const ageMs = Math.max(0, nowMs - recordedAt);
          let ageDays = ageMs / DAY_MS;
          if (Number.isFinite(upperBoundDays) && upperBoundDays > 0) {
            ageDays = Math.min(ageDays, upperBoundDays);
          }
          decay = Math.pow(0.5, ageDays / halfLifeDays);
        }
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Metadata store failed while resolving search recency.",
          { retryable: true },
        );
      }
      decayed.push({ ...candidate, score: candidate.score * decay, decay });
    }

    decayed.sort((a, b) => b.score - a.score || a.chunkId - b.chunkId);

    return { ...info, mergedCandidates: decayed };
  }

  async _resolveRecency(
    candidate: ChunkCandidate,
    metadataStore: MetadataStoreContract | null | undefined,
  ): Promise<number | null> {
    if (candidate.recordedAt != null) {
      const direct = Number(candidate.recordedAt);
      if (Number.isFinite(direct)) return direct;
    }
    if (
      typeof metadataStore?.getFileByChunkId === "function" &&
      candidate.chunkId != null
    ) {
      const file = await metadataStore.getFileByChunkId(candidate.chunkId);
      if (file) {
        const recordedAt = Number(file.recorded_at);
        if (Number.isFinite(recordedAt)) return recordedAt;
      }
    }
    return null;
  }
}

export default TimeDecayStage;
