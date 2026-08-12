import type {
  ChunkCandidate,
  PipelineContextLike,
  PipelineData,
  TagGraphPropagationData,
} from "../../types.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";
import {
  buildRowOperator,
  solveGraphDiffusion,
  distributionToEntries,
} from "../../algorithms/tag-graph/graph-diffusion-solver.js";
import type {
  GraphDiffusionResult,
  DistributionOperator,
} from "../../algorithms/tag-graph/graph-diffusion-solver.js";

type DistributionEntry = readonly [number, number];
type PrunedDistribution = Array<DistributionEntry> & {
  prunedDistributionEntries: number;
};

/**
 * GraphDiffusionStage — dual graph-diffusion over activation output.
 *
 * The activation distribution becomes the source mass of a scaled-resolvent
 * diffusion over the tag association graph: a low-alpha local scale and a high-alpha
 * transfer scale are solved in one iteration frame, reduced to effective
 * support domains (mass-ratio / shannon / participation-ratio), and the
 * candidates are re-ranked with a tag association bonus when their tags fall inside
 * the transfer domain.
 *
 * Input:  ActivationPropagationStage output ({ tagGraphPropagation: { activations, ... },
 *          mergedCandidates: [{ chunkId, score, tags? }] })
 * Config (ctx.config):
 *   - tagGraphPropagationEnabled      gate (default false)
 *   - local.alpha / transfer.alpha / tolerances / maxIterations (solver passthrough)
 *   - tagGraphBonusCap       rerank bonus cap (default 0.08)
 *   - supportSelectionMethod = activation     weak distribution entry pruning
 * Context (ctx):
 *   - ctx.tagAssociationGraph           Map<tagId, Map<neighborId, associationWeight>>
 *   - ctx.metadataStore       tag id/name resolution for rerank and readout
 *
 * Output: { ..., tagGraphPropagation: { schema, seedDistribution, localDistribution,
 *          extendedDistribution, localSupport, extendedSupport, ranked,
 *          solverDiagnostics } } or graphDiffusionSkipped.
 */
class GraphDiffusionStage extends Stage {
  constructor() {
    super();
    this.name = "graphDiffusion";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "tagGraphPropagation" | "mergedCandidates"> & {
      tagGraphPropagation?: TagGraphPropagationData;
      mergedCandidates?: ChunkCandidate[];
      graphDiffusionSkipped?: boolean;
    }
  > {
    const info = input || {};
    const config = ctx.config;

    if (!config.tagGraphPropagationEnabled) {
      return { ...info, graphDiffusionSkipped: true };
    }
    if (
      config.nativeTagRetrievalEnabled === true &&
      info.tagRetrievalSkipped === false
    ) {
      return { ...info, tagGraphPropagationNative: true };
    }

    const tagAssociationGraph =
      ctx.tagAssociationGraph instanceof Map ? ctx.tagAssociationGraph : new Map();
    if (tagAssociationGraph.size === 0) {
      return { ...info, graphDiffusionSkipped: true };
    }

    const sourceEntries = this._seedDistribution(info, ctx);
    if (sourceEntries.length === 0) {
      return { ...info, graphDiffusionSkipped: true };
    }

    let operator: DistributionOperator;
    try {
      operator = buildRowOperator(tagAssociationGraph);
    } catch {
      return { ...info, graphDiffusionSkipped: true };
    }

    let solved;
    try {
      solved = solveGraphDiffusion({
        localOperator: operator,
        transferOperator: operator,
        seedDistribution: sourceEntries,
        local: {
          alpha: config.localDiffusionAlpha ?? 0.15,
          maxIterations:
            config.diffusionMaxIterations ?? config.diffusionMaxIterations ?? 200,
          tolerance: config.localDiffusionTolerance ?? 1e-9,
        },
        transfer: {
          alpha: config.extendedDiffusionAlpha ?? 0.55,
          maxIterations:
            config.diffusionMaxIterations ?? config.diffusionMaxIterations ?? 200,
          tolerance: config.localDiffusionTolerance ?? 1e-9,
        },
        support: {
          method: config.supportSelectionMethod || "mass_ratio",
          localSupportMassRatio: config.localSupportMassRatio ?? 0.8,
          extendedSupportMassRatio: config.extendedSupportMassRatio ?? 0.9,
        },
      });
    } catch (e) {
      if (
        e instanceof Error &&
        "code" in e &&
        e.code === "TAG_RETRIEVAL_EMPTY_SOURCE"
      ) {
        return { ...info, graphDiffusionSkipped: true };
      }
      throw e;
    }

    const nameById = await this._nameIndex(ctx);
    const seedDistribution = distributionToEntries(solved.sourceVector, operator);
    const pruneConfig = {
      enabled: config.supportSelectionMethod === "activation",
      minActivation: 0,
    };
    const localDistribution: ReadonlyArray<DistributionEntry> = pruneConfig.enabled
      ? this._pruneDistribution(solved.localDistribution, pruneConfig.minActivation)
      : solved.localDistribution;
    const prunedDistributionEntries = pruneConfig.enabled
      ? this._pruneDistribution(solved.localDistribution, pruneConfig.minActivation)
          .prunedDistributionEntries
      : 0;

    const ranked = localDistribution
      .map((entry) => ({
        id: Number(entry[0]),
        name: nameById.get(Number(entry[0])) || null,
        activation: Number(entry[1]) || 0,
      }))
      .sort((left, right) => right.activation - left.activation || left.id - right.id);

    const mergedCandidates = await this._rerankCandidates(
      info.mergedCandidates,
      solved,
      ctx,
    );

    const tagGraphPropagation: TagGraphPropagationData = {
      schema: "tag-graph-diffusion-v1",
      algorithmVersion: "tag-graph-diffusion",
      seedDistribution,
      localDistribution,
      extendedDistribution: solved.extendedDistribution,
      localSupport: solved.localSupport,
      extendedSupport: solved.extendedSupport,
      ranked,
      solverDiagnostics: solved.diagnostics,
      activations: new Map(
        solved.localDistribution.map((entry) => [Number(entry[0]), Number(entry[1])]),
      ),
      pruneSkipped: true,
      prunedDistributionEntries: 0,
    };

    if (pruneConfig.enabled) {
      tagGraphPropagation.pruneSkipped = false;
      tagGraphPropagation.prunedDistributionEntries = prunedDistributionEntries;
      tagGraphPropagation.pruneThreshold = pruneConfig.minActivation;
    }

    return {
      ...info,
      tagGraphPropagation,
      mergedCandidates,
    };
  }

  /**
   * Resolve the source mass distribution for the diffusion.
   *
   * @param {object} info - pipeline input
   * @param {object} ctx  - pipeline context
   * @returns {Array<[number, number]>}
   */
  _seedDistribution(
    info: PipelineData,
    _ctx: PipelineContextLike,
  ): DistributionEntry[] {
    const propagation = info.tagGraphPropagation;
    if (propagation && propagation.activations instanceof Map) {
      const entries: DistributionEntry[] = [];
      for (const [id, activation] of propagation.activations.entries()) {
        const numericId = Number(id);
        const numericActivation = Math.max(0, Number(activation) || 0);
        if (Number.isFinite(numericId) && numericActivation > 0) {
          entries.push([numericId, numericActivation]);
        }
      }
      return entries.sort((left, right) => right[1] - left[1] || left[0] - right[0]);
    }
    if (
      propagation &&
      Array.isArray(propagation.seedDistribution) &&
      propagation.seedDistribution.length > 0
    ) {
      return propagation.seedDistribution.map(
        (entry) => [Number(entry[0]), Number(entry[1])] as const,
      );
    }
    const tagResidualDecompositionTags =
      info.tagResidualDecomposition?.levels?.[0]?.tags || [];
    const entries: DistributionEntry[] = [];
    for (const tag of tagResidualDecompositionTags) {
      const id = Number(tag && tag.id);
      const activation = Math.max(0, Number(tag && tag.contribution) || 0);
      if (Number.isFinite(id) && activation > 0) entries.push([id, activation]);
    }
    return entries;
  }

  _pruneDistribution(
    distribution: ReadonlyArray<DistributionEntry>,
    minActivation: number,
  ): PrunedDistribution {
    const retained: PrunedDistribution = [] as unknown as PrunedDistribution;
    let prunedEntries = 0;
    for (const entry of distribution) {
      if ((Number(entry[1]) || 0) < minActivation) {
        prunedEntries += 1;
        continue;
      }
      retained.push(entry);
    }
    retained.prunedDistributionEntries = prunedEntries;
    return retained;
  }

  async _nameIndex(ctx: PipelineContextLike): Promise<Map<number, string>> {
    const names = new Map<number, string>();
    const metadataStore = ctx.metadataStore;
    if (!metadataStore || typeof metadataStore.getAllTags !== "function") {
      return names;
    }
    let rows;
    try {
      rows =
        typeof metadataStore.getActiveTags === "function"
          ? await metadataStore.getActiveTags()
          : await metadataStore.getAllTags();
    } catch (e) {
      throw asMemoriaError(
        e,
        "persistence",
        "Metadata store failed while naming tag association propagation tags.",
        { retryable: true },
      );
    }
    for (const row of rows || []) {
      const id = Number(row && row.id);
      if (Number.isFinite(id) && row && row.name) names.set(id, row.name);
    }
    return names;
  }

  async _candidateTagIds(
    candidate: ChunkCandidate,
    ctx: PipelineContextLike,
  ): Promise<number[]> {
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
        if (metadataStore && typeof metadataStore.getTagByName === "function") {
          try {
            tag = await metadataStore.getTagByName(name);
          } catch (e) {
            throw asMemoriaError(
              e,
              "persistence",
              "Metadata store failed while resolving a tag association propagation seed.",
              { retryable: true },
            );
          }
        }
        if (tag && Number.isFinite(Number(tag.id))) ids.push(Number(tag.id));
      }
      return ids;
    }

    if (
      typeof metadataStore?.getFileByChunkId !== "function" ||
      typeof metadataStore?.getFileTags !== "function"
    ) {
      return [];
    }
    try {
      const chunkId = Number(candidate && candidate.chunkId);
      if (!Number.isFinite(chunkId)) return [];
      const file = await metadataStore.getFileByChunkId(chunkId);
      if (!file) return [];
      const tagRows = await metadataStore.getFileTags(file.id);
      return (tagRows || []).map((row) => Number(row.id)).filter(Number.isFinite);
    } catch (e) {
      throw asMemoriaError(
        e,
        "persistence",
        "Metadata store failed while resolving candidate tag association propagation tags.",
        { retryable: true },
      );
    }
  }

  async _rerankCandidates(
    candidates: readonly ChunkCandidate[] | undefined,
    solved: Readonly<GraphDiffusionResult>,
    ctx: PipelineContextLike,
  ): Promise<ChunkCandidate[]> {
    const source = Array.isArray(candidates) ? candidates : [];
    if (source.length === 0) return source;
    const cap = Math.max(0, Number(ctx.config?.historyRerankCap) || 0.08);
    const saturation = Math.max(1e-6, Number(ctx.config?.supportRerankAlpha) || 0.15);
    const domain = new Set([...solved.localSupport.ids, ...solved.extendedSupport.ids]);

    const results: ChunkCandidate[] = [];
    for (const candidate of source) {
      const tagIds = await this._candidateTagIds(candidate, ctx);
      const hits = tagIds.filter((id) => domain.has(id)).length;
      const associationGraphScore = tagIds.length > 0 ? hits / tagIds.length : 0;
      const pathReliability = Math.min(
        1,
        associationGraphScore >= 1 ? 1 : associationGraphScore / saturation,
      );
      const propagationReliability = Math.sqrt(pathReliability * 1);
      const propagationBonus = Math.min(
        cap,
        cap * associationGraphScore * propagationReliability,
      );
      const score = Math.max(
        0,
        Math.min(1, (Number(candidate.score) || 0) + propagationBonus),
      );
      results.push({
        ...candidate,
        score,
        propagationBonus,
        propagationScore: associationGraphScore,
        propagationReliability,
        domainHits: tagIds.filter((id) => domain.has(id)),
      });
    }
    results.sort(
      (left, right) => right.score - left.score || left.chunkId - right.chunkId,
    );
    return results;
  }
}

export default GraphDiffusionStage;
