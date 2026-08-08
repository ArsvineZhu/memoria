'use strict';

const Stage = require('../../core/stage');
const { propagate } = require('../../algorithms/wave-propagation');

/**
 * TagMemoV9Stage — TagMemo v9 spike propagation over the tag graph.
 *
 * Faithful port of TagMemoEngine._propagateSpikes (v9.1 soft non-backtracking
 * FIR readout). The production engine seeds spikes from pyramid tags carrying
 * residual contribution energy; here the seeds come from the residual-pyramid
 * output (pyramid.levels[0].tags) or, in absence of a pyramid, from the tags
 * attached to the merged candidates (fallback path). The engine keeps the
 * spike propagator coupled to its stores; this stage performs the same
 * activation on an injected tag graph (ctx.tagGraph) using the pure
 * wave-propagation kernel.
 *
 * Input:  { queryVector?, pyramid?, mergedCandidates: [{ chunkId, score, tags? }] }
 * Config (ctx.config):
 *   - tagMemoV9Enabled     gate (default false)
 *   - wave config passthrough (maxSafeHops, tensionThreshold, pruneAbove ...)
 * Context (ctx):
 *   - ctx.tagGraph         Map<tagId, Map<neighborId, conductance>>
 *   - ctx.metadataStore    tag id/name resolution and fallback seeding
 *
 * Output: { ..., tagMemo: { version, activations: Map, ranked, iterations,
 *          riverGraph, fieldProvenance, diagnostics } } or tagMemoSkipped.
 */
class TagMemoV9Stage extends Stage {
  constructor() {
    super();
    this.name = 'tagMemoV9';
  }

  async process(input, ctx) {
    const info = input || {};
    const config = ctx.config || {};

    if (!config.tagMemoV9Enabled) {
      return { ...info, tagMemoSkipped: true };
    }

    const tagGraph = ctx.tagGraph instanceof Map
      ? ctx.tagGraph
      : new Map();

    const seeds = this._pyramidSeeds(info);
    const fallbackSeeds = seeds.length === 0;
    let resolvedSeeds = seeds;
    if (seeds.length === 0) {
      resolvedSeeds = await this._candidateTagSeeds(
        info.mergedCandidates, ctx
      );
    }
    if (resolvedSeeds.length === 0 || tagGraph.size === 0) {
      return { ...info, tagMemoSkipped: true };
    }

    const observed = propagate({
      sources: resolvedSeeds,
      graph: tagGraph,
      config: this._propagateConfig(config)
    });

    const nameById = await this._nameIndex(ctx);

    // Ranked readout: direct seeds lead by readout energy, indeterminate
    // emergent nodes follow by energy (sourceType priority matches the
    // engine's direct-anchor readout semantics).
    const ranked = [...observed.activations.entries()]
      .map(([id, energy]) => ({
        id: Number(id),
        name: nameById.get(Number(id)) || null,
        energy,
        sourceType: observed.fieldProvenance.get(Number(id))?.sourceType || 'unknown'
      }))
      .sort((left, right) => {
        const leftDirect = left.sourceType === 'seed' || left.sourceType === 'core' ? 1 : 0;
        const rightDirect = right.sourceType === 'seed' || right.sourceType === 'core' ? 1 : 0;
        return (rightDirect - leftDirect)
          || (right.energy - left.energy)
          || (left.id - right.id);
      });

    return {
      ...info,
      tagMemo: {
        version: 'v9',
        activations: observed.activations,
        ranked,
        iterations: observed.iterations,
        riverGraph: observed.riverGraph,
        fieldProvenance: observed.fieldProvenance,
        diagnostics: observed.diagnostics,
        seedFallback: fallbackSeeds
      }
    };
  }

  _pyramidSeeds(info) {
    const pyramidTags = info.pyramid?.levels?.[0]?.tags || [];
    const seeds = [];
    for (const tag of pyramidTags) {
      const id = Number(tag && tag.id);
      if (!Number.isFinite(id)) continue;
      seeds.push({
        id,
        energy: Math.max(0, Number(tag.contribution) || 0) || 1,
        isCore: tag.isCore === true,
        name: tag.name || null
      });
    }
    return seeds.sort((left, right) => left.id - right.id);
  }

  async _candidateTagSeeds(candidates, ctx) {
    const metadataStore = ctx.metadataStore;
    const resolved = new Map();
    const seeds = [];
    for (const candidate of candidates || []) {
      const tags = candidate && candidate.tags;
      if (!Array.isArray(tags)) continue;
      for (const rawName of tags) {
        const name = String(rawName);
        if (resolved.has(name)) {
          const existing = resolved.get(name);
          if (existing && !seeds.includes(existing)) seeds.push(existing);
          continue;
        }
        resolved.set(name, null);
        let tag = null;
        if (metadataStore && typeof metadataStore.getTagByName === 'function') {
          try {
            tag = await metadataStore.getTagByName(name);
          } catch (e) {
            tag = null;
          }
        }
        const id = Number(tag && tag.id);
        if (!Number.isFinite(id)) continue;
        const seed = { id, energy: 1, isCore: false, name };
        resolved.set(name, seed);
        seeds.push(seed);
      }
    }
    return seeds.sort((left, right) => left.id - right.id);
  }

  async _nameIndex(ctx, info) {
    const names = new Map();
    const pyramidTags = info?.pyramid?.levels?.[0]?.tags || [];
    for (const tag of pyramidTags) {
      const id = Number(tag && tag.id);
      if (Number.isFinite(id) && tag && tag.name) names.set(id, tag.name);
    }
    const metadataStore = ctx.metadataStore;
    if (!metadataStore || typeof metadataStore.getAllTags !== 'function') {
      return names;
    }
    let rows;
    try {
      rows = await metadataStore.getAllTags();
    } catch (e) {
      return names;
    }
    for (const row of rows || []) {
      const id = Number(row && row.id);
      if (Number.isFinite(id) && row && row.name) names.set(id, row.name);
    }
    return names;
  }

  _propagateConfig(config) {
    const passthrough = {};
    for (const key of [
      'maxSafeHops',
      'tensionThreshold',
      'firingThreshold',
      'baseDecay',
      'wormholeDecay',
      'baseMomentum',
      'maxNeighborsPerNode',
      'v91ReturnFlowFactor',
      'v91FirGamma',
      'pruneAbove',
      'maxPropagationStates'
    ]) {
      if (config[key] !== undefined) passthrough[key] = config[key];
    }
    return passthrough;
  }
}

module.exports = TagMemoV9Stage;