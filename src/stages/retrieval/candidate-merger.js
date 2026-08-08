'use strict';

const Stage = require('../../core/stage');

// Recency decay: score *= 0.5 ^ (age / halfLife), with halfLife in days.
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Fuses vector and BM25 candidate lists into a single ranked result set.
 *
 * Mirrors the LightMemo hybrid fusion (normalized BM25 + vector similarity
 * with configurable weights, cf. hybridAlpha in TDBKnowledge.searchLibrary):
 * raw scores of each source are normalized to [0,1] by their source max,
 * combined as a weighted sum, deduped by chunk id, minScore-filtered,
 * then optionally decayed by file recency (timeDecayHalfLife) and cut to
 * topK.
 *
 * Input: { vectorResults: [{ indexName, chunkId, score }],
 *          bm25Results: [{ chunkId, score }] }
 *
 * Config (ctx.config):
 *   - vectorWeight     hybrid weight of the vector source (default 0.6)
 *   - bm25Weight       hybrid weight of the BM25 source (default 1 - vector)
 *   - hybridAlpha      alias for the vector weight (TDBKnowledge naming)
 *   - hybridBeta       alias for the BM25 weight
 *   - minScore         absolute merged-score threshold (default 0)
 *   - timeDecayHalfLife: score half-life in DAYS for recency decay
 *   - timeDecayNow     epoch-ms clock override (tests / determinism)
 *   - topK             max candidates returned (default 5)
 *
 * Output: { mergedCandidates: [{ chunkId, score, source, vectorScore,
 *          bm25Score, decay? }] } sorted desc.
 */
class CandidateMergerStage extends Stage {
  constructor() {
    super();
    this.name = 'candidateMerger';
  }

  async process(input, ctx) {
    const info = input || {};
    const config = ctx.config || {};
    const weights = this._resolveWeights(config);

    const vectorResults = Array.isArray(info.vectorResults)
      ? info.vectorResults
      : [];
    const bm25Results = Array.isArray(info.bm25Results)
      ? info.bm25Results
      : [];

    // 1. Dedupe each source by chunk id, keeping the best score.
    const vecById = new Map();
    for (const result of vectorResults) {
      const chunkId = Number(result.chunkId);
      if (!Number.isFinite(chunkId)) continue;
      const score = Number(result.score) || 0;
      const previous = vecById.get(chunkId);
      if (previous === undefined || score > previous) {
        vecById.set(chunkId, score);
      }
    }
    const bm25ById = new Map();
    for (const result of bm25Results) {
      const chunkId = Number(result.chunkId);
      if (!Number.isFinite(chunkId)) continue;
      const score = Number(result.score) || 0;
      const previous = bm25ById.get(chunkId);
      if (previous === undefined || score > previous) {
        bm25ById.set(chunkId, score);
      }
    }

    // 2. Normalize per source to [0,1] by max, then weighted sum.
    const vecMax = vecById.size > 0 ? Math.max(...vecById.values()) : 0;
    const bm25Max = bm25ById.size > 0 ? Math.max(...bm25ById.values()) : 0;

    const ids = new Set([...vecById.keys(), ...bm25ById.keys()]);
    let merged = [];
    for (const chunkId of ids) {
      const vectorScore = vecById.get(chunkId) || 0;
      const bm25Score = bm25ById.get(chunkId) || 0;
      const normalizedVector = vecMax > 0 ? vectorScore / vecMax : 0;
      const normalizedBm25 = bm25Max > 0 ? bm25Score / bm25Max : 0;
      const score = (
        weights.vectorWeight * normalizedVector
        + weights.bm25Weight * normalizedBm25
      );
      const source = vectorScore > 0 && bm25Score > 0
        ? 'hybrid'
        : (vectorScore > 0 ? 'vector' : 'bm25');
      merged.push({
        chunkId,
        score,
        source,
        vectorScore,
        bm25Score
      });
    }

    // 3. minScore threshold.
    const minScore = Number(config.minScore) || 0;
    if (minScore > 0) {
      merged = merged.filter(candidate => candidate.score >= minScore);
    }

    // 4. Optional recency decay via file updated_at / mtime.
    const halfLifeDays = Number(config.timeDecayHalfLife);
    if (halfLifeDays > 0 && ctx.metadataStore) {
      merged = await this._applyTimeDecay(
        merged,
        halfLifeDays,
        config,
        ctx.metadataStore
      );
    }

    // 5. Sort desc and cap to topK.
    merged.sort((a, b) => (b.score - a.score) || (a.chunkId - b.chunkId));
    const topK = Math.max(
      1,
      Math.round(Number(info.topK ?? config.topK ?? 5))
    );
    merged = merged.slice(0, topK);

    return { ...info, mergedCandidates: merged };
  }

  _resolveWeights(config) {
    let vectorWeight;
    if (
      config.vectorWeight != null
      && Number.isFinite(Number(config.vectorWeight))
    ) {
      vectorWeight = Number(config.vectorWeight);
    } else if (
      config.hybridAlpha != null
      && Number.isFinite(Number(config.hybridAlpha))
    ) {
      vectorWeight = Number(config.hybridAlpha);
    } else {
      vectorWeight = 0.6;
    }

    let bm25Weight;
    if (
      config.bm25Weight != null
      && Number.isFinite(Number(config.bm25Weight))
    ) {
      bm25Weight = Number(config.bm25Weight);
    } else if (
      config.hybridBeta != null
      && Number.isFinite(Number(config.hybridBeta))
    ) {
      bm25Weight = Number(config.hybridBeta);
    } else {
      bm25Weight = 1 - vectorWeight;
    }

    const total = Math.max(1e-9, vectorWeight + bm25Weight);
    return {
      vectorWeight: vectorWeight / total,
      bm25Weight: bm25Weight / total
    };
  }

  async _applyTimeDecay(candidates, halfLifeDays, config, metadataStore) {
    const nowMs = Number(config.timeDecayNow) || Date.now();
    if (typeof metadataStore.getFileByChunkId !== 'function') {
      return candidates;
    }

    const decayed = [];
    for (const candidate of candidates) {
      let decay = 1;
      try {
        const file = await metadataStore.getFileByChunkId(candidate.chunkId);
        if (file) {
          const updatedSeconds = file.updated_at != null
            ? Number(file.updated_at)
            : null;
          const recencySeconds = updatedSeconds != null && Number.isFinite(updatedSeconds)
            ? updatedSeconds
            : Number(file.mtime) || null;
          if (recencySeconds != null && Number.isFinite(recencySeconds)) {
            const ageMs = Math.max(0, nowMs - recencySeconds * 1000);
            decay = Math.pow(0.5, ageMs / (halfLifeDays * DAY_MS));
          }
        }
      } catch (e) {
        decay = 1;
      }
      decayed.push({
        ...candidate,
        score: candidate.score * decay,
        decay
      });
    }
    return decayed;
  }
}

module.exports = CandidateMergerStage;