'use strict';

const Stage = require('../../core/stage');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Postprocess stage: recency-based score decay on merged candidates.
 *
 * Each candidate's owning file `updated_at` (or `mtime`) age in days is
 * converted to a decay multiplier 0.5 ^ (ageDays / halfLifeDays), following
 * the LightMemo/TDB recency formula. Scores are multiplied by the decay;
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
    this.name = 'timeDecay';
  }

  async process(input, ctx) {
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
        const recencySeconds = await this._resolveRecency(
          candidate,
          metadataStore
        );
        if (recencySeconds !== null && Number.isFinite(recencySeconds)) {
          const ageMs = Math.max(0, nowMs - recencySeconds * 1000);
          let ageDays = ageMs / DAY_MS;
          if (Number.isFinite(upperBoundDays) && upperBoundDays > 0) {
            ageDays = Math.min(ageDays, upperBoundDays);
          }
          decay = Math.pow(0.5, ageDays / halfLifeDays);
        }
      } catch (error) {
        decay = 1;
      }
      decayed.push({ ...candidate, score: candidate.score * decay, decay });
    }

    decayed.sort((a, b) => (b.score - a.score) || (a.chunkId - b.chunkId));

    return { ...info, mergedCandidates: decayed };
  }

  async _resolveRecency(candidate, metadataStore) {
    if (candidate.updated_at != null) {
      const direct = Number(candidate.updated_at);
      if (Number.isFinite(direct)) return direct;
    }
    if (candidate.mtime != null) {
      const direct = Number(candidate.mtime);
      if (Number.isFinite(direct)) return direct;
    }
    if (
      typeof metadataStore?.getFileByChunkId === 'function'
      && candidate.chunkId != null
    ) {
      const file = await metadataStore.getFileByChunkId(candidate.chunkId);
      if (file) {
        const updatedSeconds = file.updated_at != null
          ? Number(file.updated_at)
          : null;
        if (updatedSeconds != null && Number.isFinite(updatedSeconds)) {
          return updatedSeconds;
        }
        const mtimeSeconds = file.mtime != null ? Number(file.mtime) : null;
        if (mtimeSeconds != null && Number.isFinite(mtimeSeconds)) {
          return mtimeSeconds;
        }
      }
    }
    return null;
  }
}

module.exports = TimeDecayStage;