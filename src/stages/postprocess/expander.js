'use strict';

const Stage = require('../../core/stage');

/**
 * Postprocess stage: expands final results with related same-file chunks.
 *
 * The original KnowledgeBase search() does not attach an association /
 * expansion layer to its result assembly, so this stage is config-gated off
 * by default. When enabled it mirrors the "related memory" pattern used by
 * the associate/expand flows elsewhere in the project (e.g. DailyNote
 * association): for the top `expandCount` candidates, sibling chunks of the
 * same file are appended with their base score scaled by `expansionBoost`.
 *
 * Input: { mergedCandidates: [{ chunkId, score, ... }] }
 * Output: { ..., mergedCandidates (re-sorted desc), expansionStats: { added } }
 *
 * Config (ctx.config):
 *   - expansionEnabled     gate (default false)
 *   - expandCount          how many top candidates seed expansion (default 2)
 *   - expansionBoost       score multiplier for expanded siblings (default 0.5)
 *   - expandSameFile       expand within the same file (default true)
 */
class ExpanderStage extends Stage {
  constructor() {
    super();
    this.name = 'expander';
  }

  async process(input, ctx) {
    const info = input || {};
    const config = ctx.config || {};
    const candidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];

    const expandCount = Math.max(
      0,
      Math.round(Number(config.expandCount) || 2)
    );
    const baseBoost = Number(config.expansionBoost);

    // Default boost mirrors the weight used by associate-style expansion of
    // related memories (half the original score).
    const expansionBoost = Number.isFinite(baseBoost) ? baseBoost : 0.5;

    if (
      config.expansionEnabled !== true
      || typeof ctx.metadataStore?.getFileByChunkId !== 'function'
      || typeof ctx.metadataStore?.getChunksByFileId !== 'function'
      || candidates.length === 0
    ) {
      return { ...info, mergedCandidates: candidates, expansionStats: { added: 0 } };
    }

    const result = [];
    const presentIds = new Set();
    for (const candidate of candidates) {
      result.push(candidate);
      presentIds.add(Number(candidate && candidate.chunkId));
    }

    let added = 0;
    const seedCount = Math.min(expandCount, candidates.length);
    for (let index = 0; index < seedCount; index += 1) {
      const seed = candidates[index];
      const seedChunkId = Number(seed && seed.chunkId);
      if (!Number.isFinite(seedChunkId)) continue;

      let file;
      try {
        file = await ctx.metadataStore.getFileByChunkId(seedChunkId);
      } catch (error) {
        continue;
      }
      if (!file) continue;

      let siblings;
      try {
        siblings = await ctx.metadataStore.getChunksByFileId(file.id);
      } catch (error) {
        continue;
      }
      if (!Array.isArray(siblings)) continue;

for (const sibling of siblings) {
        const siblingId = Number(sibling && sibling.id);
        if (!Number.isFinite(siblingId) || presentIds.has(siblingId)) continue;
        result.push({
          chunkId: siblingId,
          score: (seed.score || 0) * expansionBoost,
          source: 'expansion',
          expansionOf: seedChunkId
        });
        presentIds.add(siblingId);
        added += 1;
      }
    }

    result.sort(
      (a, b) => (b.score - a.score) || (Number(a.chunkId) - Number(b.chunkId))
    );

    return {
      ...info,
      mergedCandidates: result,
      expansionStats: { added }
    };
  }
}

module.exports = ExpanderStage;