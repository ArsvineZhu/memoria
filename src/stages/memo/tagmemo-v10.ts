
import type {
  ChunkCandidate,
  MemoryConfig,
  PipelineContextLike,
  PipelineData,
  TagMemoData,
  UnknownRecord,
} from '../../types';

import Stage = require('../../core/stage');
import { buildRowOperator, solveDualScaledFields, fieldToEntries } from '../../algorithms/topology/scaled-field-solver';
import type { ScaledFieldResult, FieldOperator } from '../../algorithms/topology/scaled-field-solver';

type FieldEntry = readonly [number, number];
type PrunedField = Array<FieldEntry> & { prunedEntries: number };

/**
 * TagMemoV10Stage — dual scaled-field diffusion over the v9 wave.
 *
 * Faithful port of the TagMemoV10 engine's scaled-field phase
 * (modules/tagmemoV10/scaledFieldSolver + direct-anchor readout semantics).
 * The v9 activation field becomes the source mass of a scaled-resolvent
 * diffusion over the tag graph: a low-alpha local scale and a high-alpha
 * transfer scale are solved in one iteration frame, reduced to effective
 * support domains (mass-ratio / shannon / participation-ratio), and the
 * candidates are re-ranked with a topology bonus when their tags fall inside
 * the transfer domain.
 *
 * Input:  TagMemoV9Stage output ({ tagMemo: { activations, ... },
 *          mergedCandidates: [{ chunkId, score, tags? }] })
 * Config (ctx.config):
 *   - tagMemoV10Enabled      gate (default false)
 *   - local.alpha / transfer.alpha / tolerances / maxIterations (solver passthrough)
 *   - topologyBonusCap       rerank bonus cap (default 0.08)
 *   - pruneByEnergy + minFieldEnergy   weak field entry pruning
 * Context (ctx):
 *   - ctx.tagGraph           Map<tagId, Map<neighborId, conductance>>
 *   - ctx.metadataStore       tag id/name resolution for rerank and readout
 *
 * Output: { ..., tagMemo: { version: 'v10', sourceField, localField,
 *          transferField, localDomain, transferDomain, ranked,
 *          solverDiagnostics } } or tagMemoV10Skipped.
 */
class TagMemoV10Stage extends Stage {
  constructor() {
    super();
    this.name = 'tagMemoV10';
  }

  async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<Omit<PipelineData, 'tagMemo' | 'mergedCandidates'> & {
    tagMemo?: TagMemoData;
    mergedCandidates?: ChunkCandidate[];
    tagMemoV10Skipped?: boolean;
  }> {
    const info = input || {};
    const config = ctx.config;

    if (!config.tagMemoV10Enabled) {
      return { ...info, tagMemoV10Skipped: true };
    }

    const tagGraph = ctx.tagGraph instanceof Map ? ctx.tagGraph : new Map();
    if (tagGraph.size === 0) {
      return { ...info, tagMemoV10Skipped: true };
    }

    const sourceEntries = this._sourceField(info, ctx);
    if (sourceEntries.length === 0) {
      return { ...info, tagMemoV10Skipped: true };
    }

    let operator: FieldOperator;
    try {
      operator = buildRowOperator(tagGraph);
    } catch (e) {
      return { ...info, tagMemoV10Skipped: true };
    }

    let solved;
    try {
      solved = solveDualScaledFields({
        localOperator: operator,
        transferOperator: operator,
        sourceField: sourceEntries,
        local: {
          alpha: config.localAlpha ?? 0.15,
          maxIterations: config.localMaxIterations ?? config.solverMaxIterations ?? 200,
          tolerance: config.solverTolerance ?? 1e-9
        },
        transfer: {
          alpha: config.transferAlpha ?? 0.55,
          maxIterations: config.transferMaxIterations ?? config.solverMaxIterations ?? 200,
          tolerance: config.solverTolerance ?? 1e-9
        },
        support: {
          method: config.supportMethod || 'mass_ratio',
          localMassRatio: config.localMassRatio ?? 0.8,
          transferMassRatio: config.transferMassRatio ?? 0.9
        }
      });
    } catch (e) {
      if (e instanceof Error && 'code' in e && e.code === 'TAGMEMO_V10_EMPTY_SOURCE') {
        return { ...info, tagMemoV10Skipped: true };
      }
      throw e;
    }

    const nameById = await this._nameIndex(ctx);
    const sourceField = fieldToEntries(solved.sourceVector, operator);
    const pruneConfig = {
      enabled: config.pruneByEnergy === true,
      minEnergy: Math.max(0, Number(config.minFieldEnergy) || 0)
    };
    const localField: ReadonlyArray<FieldEntry> = pruneConfig.enabled
      ? this._pruneField(solved.localField, pruneConfig.minEnergy)
      : solved.localField;
    const prunedFieldEntries = pruneConfig.enabled
      ? this._pruneField(solved.localField, pruneConfig.minEnergy).prunedEntries
      : 0;

    const ranked = localField
      .map(entry => ({
        id: Number(entry[0]),
        name: nameById.get(Number(entry[0])) || null,
        energy: Number(entry[1]) || 0
      }))
      .sort((left, right) => (right.energy - left.energy) || (left.id - right.id));

    const mergedCandidates = await this._rerankCandidates(
      info.mergedCandidates, solved, ctx
    );

    const tagMemo: TagMemoData = {
      version: 'v10',
      sourceField,
      localField,
      transferField: solved.transferField,
      localDomain: solved.localDomain,
      transferDomain: solved.transferDomain,
      ranked,
      solverDiagnostics: solved.diagnostics,
      activations: new Map(solved.localField.map(entry => [Number(entry[0]), Number(entry[1])])),
      pruneSkipped: true,
      prunedFieldEntries: 0
    };

    if (pruneConfig.enabled) {
      tagMemo.pruneSkipped = false;
      tagMemo.prunedFieldEntries = prunedFieldEntries;
      tagMemo.pruneThreshold = pruneConfig.minEnergy;
    }

    return {
      ...info,
      tagMemo,
      mergedCandidates
    };
  }

  /**
   * Resolve the source mass field for the diffusion.
   *
   * @param {object} info - pipeline input
   * @param {object} ctx  - pipeline context
   * @returns {Array<[number, number]>}
   */
  _sourceField(info: PipelineData, _ctx: PipelineContextLike): FieldEntry[] {
    const memo = info.tagMemo;
    if (memo && memo.activations instanceof Map) {
      const entries: FieldEntry[] = [];
      for (const [id, energy] of memo.activations.entries()) {
        const numericId = Number(id);
        const numericEnergy = Math.max(0, Number(energy) || 0);
        if (Number.isFinite(numericId) && numericEnergy > 0) {
          entries.push([numericId, numericEnergy]);
        }
      }
      return entries.sort((left, right) =>
        (right[1] - left[1]) || (left[0] - right[0])
      );
    }
    if (memo && Array.isArray(memo.sourceField) && memo.sourceField.length > 0) {
      return memo.sourceField.map(entry => [Number(entry[0]), Number(entry[1])] as const);
    }
    const pyramidTags = info.pyramid?.levels?.[0]?.tags || [];
    const entries: FieldEntry[] = [];
    for (const tag of pyramidTags) {
      const id = Number(tag && tag.id);
      const energy = Math.max(0, Number(tag && tag.contribution) || 0);
      if (Number.isFinite(id) && energy > 0) entries.push([id, energy]);
    }
    return entries;
  }

  _pruneField(field: ReadonlyArray<FieldEntry>, minEnergy: number): PrunedField {
    const retained: PrunedField = [] as unknown as PrunedField;
    let prunedEntries = 0;
    for (const entry of field) {
      if ((Number(entry[1]) || 0) < minEnergy) {
        prunedEntries += 1;
        continue;
      }
      retained.push(entry);
    }
    retained.prunedEntries = prunedEntries;
    return retained;
  }

  async _nameIndex(ctx: PipelineContextLike): Promise<Map<number, string>> {
    const names = new Map<number, string>();
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

  async _candidateTagIds(candidate: ChunkCandidate, ctx: PipelineContextLike): Promise<number[]> {
    const metadataStore = ctx.metadataStore;
    const tags = candidate && candidate.tags;
    if (Array.isArray(tags) && tags.length > 0) {
      const ids = [];
      for (const rawName of tags) {
        const name = String(rawName);
        const numericName = Number(name);
        if (Number.isFinite(numericName)) {
          ids.push(numericName);
          continue;
        }
        let tag = null;
        if (metadataStore && typeof metadataStore.getTagByName === 'function') {
          try {
            tag = await metadataStore.getTagByName(name);
          } catch (e) {
            tag = null;
          }
        }
        if (tag && Number.isFinite(Number(tag.id))) ids.push(Number(tag.id));
      }
      return ids;
    }

    if (typeof metadataStore?.getFileByChunkId !== 'function'
      || typeof metadataStore?.getFileTags !== 'function') {
      return [];
    }
    try {
      const chunkId = Number(candidate && candidate.chunkId);
      if (!Number.isFinite(chunkId)) return [];
      const file = await metadataStore.getFileByChunkId(chunkId);
      if (!file) return [];
      const tagRows = await metadataStore.getFileTags(file.id);
      return (tagRows || []).map(row => Number(row.id)).filter(Number.isFinite);
    } catch (e) {
      return [];
    }
  }

  async _rerankCandidates(
    candidates: readonly ChunkCandidate[] | undefined,
    solved: Readonly<ScaledFieldResult>,
    ctx: PipelineContextLike,
  ): Promise<ChunkCandidate[]> {
    const source = Array.isArray(candidates) ? candidates : [];
    if (source.length === 0) return source;
    const cap = Math.max(0, Number(ctx.config?.topologyBonusCap) || 0.08);
    const saturation = Math.max(1e-6, Number(ctx.config?.topologyPathSaturation) || 0.15);
    const domain = new Set([
      ...solved.localDomain.ids,
      ...solved.transferDomain.ids
    ]);

    const results: ChunkCandidate[] = [];
    for (const candidate of source) {
      const tagIds = await this._candidateTagIds(candidate, ctx);
      const hits = tagIds.filter(id => domain.has(id)).length;
      const topologyRaw = tagIds.length > 0 ? hits / tagIds.length : 0;
      const pathReliability = Math.min(
        1,
        topologyRaw >= 1 ? 1 : topologyRaw / saturation
      );
      const topologyReliability = Math.sqrt(pathReliability * 1);
      const topologyBonus = Math.min(
        cap,
        cap * topologyRaw * topologyReliability
      );
      const score = Math.max(
        0,
        Math.min(1, (Number(candidate.score) || 0) + topologyBonus)
      );
      results.push({
        ...candidate,
        score,
        topologyBonus,
        topologyRaw,
        topologyReliability,
        domainHits: tagIds.filter(id => domain.has(id))
      });
    }
    results.sort((left, right) =>
      (right.score - left.score) || (left.chunkId - right.chunkId)
    );
    return results;
  }
}

export = TagMemoV10Stage;
