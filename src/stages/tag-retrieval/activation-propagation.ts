import type { ChunkCandidate } from "../../types/documents.js";
import type { MemoryConfigOverrides } from "../../types/config.js";
import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";
import type {
  PropagationTrace,
  TagGraphPropagationData,
} from "../../types/retrieval.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";
import { propagate } from "../../algorithms/tag-graph/activation-propagation.js";
import type { ActivationSeedInput } from "../../algorithms/tag-graph/activation-propagation.js";
import { mergeTagRetrievalObservation } from "./tag-retrieval-observation.js";

/**
 * ActivationPropagationStage — activation propagation over the tag association graph.
 *
 * The stage seeds activation from residual decomposition tags carrying
 * residual contribution activation. If no residual decomposition is available,
 * it resolves seeds from tags attached to merged candidates. The graph is
 * injected through the pipeline context and the numerical kernel stays pure.
 * activation on an injected tag association graph (ctx.tagAssociationGraph) using the pure
 * activation-propagation kernel.
 *
 * Input:  { queryVector?, tagResidualDecomposition?, mergedCandidates: [{ chunkId, score, tags? }] }
 * Config (ctx.config):
 *   - tagGraphPropagationEnabled     gate (default false)
 *   - activation config passthrough (propagationMaxHops and propagation limits)
 * Context (ctx):
 *   - ctx.tagAssociationGraph         Map<tagId, Map<neighborId, associationWeight>>
 *   - ctx.metadataStore    tag id/name resolution and fallback seeding
 *
 * Output: { ..., tagGraphPropagation: { schema, activations: Map, ranked, iterations,
 *          propagationTrace, propagationProvenance, diagnostics } } or tagGraphPropagationSkipped.
 */
class ActivationPropagationStage extends Stage {
  constructor() {
    super();
    this.name = "activationPropagation";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "tagGraphPropagation"> & {
      tagGraphPropagation?: TagGraphPropagationData;
      tagGraphPropagationSkipped?: boolean;
    }
  > {
    const info = input || {};
    const config = ctx.config;

    if (!config.tagGraphPropagationEnabled) {
      return { ...info, tagGraphPropagationSkipped: true };
    }
    if (
      config.nativeTagRetrievalEnabled === true &&
      info.tagRetrievalSkipped === false
    ) {
      return { ...info, tagGraphPropagationNative: true };
    }

    let tagAssociationGraph = ctx.tagAssociationGraph;
    if (!(tagAssociationGraph instanceof Map)) {
      const loadTagAssociationGraph =
        ctx.loadTagAssociationGraph ||
        ctx.metadataStore?.buildCooccurrenceMatrix?.bind(ctx.metadataStore);
      if (loadTagAssociationGraph) {
        try {
          tagAssociationGraph = await loadTagAssociationGraph();
        } catch (error) {
          return {
            ...info,
            tagGraphPropagationSkipped: true,
            tagAssociationGraphLoadError:
              error instanceof Error ? error.message : String(error),
          };
        }
      }
    }
    if (!(tagAssociationGraph instanceof Map)) tagAssociationGraph = new Map();

    const seeds = this._tagResidualDecompositionSeeds(info);
    const fallbackSeeds = seeds.length === 0;
    let resolvedSeeds = seeds;
    if (seeds.length === 0) {
      resolvedSeeds = await this._candidateTagSeeds(info.mergedCandidates, ctx);
    }
    if (resolvedSeeds.length === 0 || tagAssociationGraph.size === 0) {
      return { ...info, tagGraphPropagationSkipped: true };
    }

    const observed = propagate({
      sources: resolvedSeeds,
      graph: tagAssociationGraph,
      config: this._propagateConfig(config),
    });

    const nameById = await this._nameIndex(ctx);

    // Ranked readout: direct seeds lead by readout activation, indeterminate
    // derived nodes follow by activation (sourceType priority matches the
    // engine's direct-anchor readout semantics).
    const ranked = [...observed.activations.entries()]
      .map(([id, activation]) => ({
        id: Number(id),
        name: nameById.get(Number(id)) || null,
        activation,
        sourceType:
          observed.propagationProvenance.get(Number(id))?.sourceType || "unknown",
      }))
      .sort((left, right) => {
        const leftDirect =
          left.sourceType === "seed" || left.sourceType === "core" ? 1 : 0;
        const rightDirect =
          right.sourceType === "seed" || right.sourceType === "core" ? 1 : 0;
        return (
          rightDirect - leftDirect ||
          right.activation - left.activation ||
          left.id - right.id
        );
      });

    const tagGraphPropagation: TagGraphPropagationData = {
      schema: "tag-graph-activation-propagation-v1",
      algorithmVersion: "tag-graph-activation-propagation",
      activations: observed.activations,
      ranked,
      iterations: observed.iterations,
      propagationTrace: observed.propagationTrace as PropagationTrace,
      propagationProvenance: observed.propagationProvenance,
      diagnostics: observed.diagnostics,
      seedFallback: fallbackSeeds,
    };
    return {
      ...info,
      tagGraphPropagation,
      tagRetrievalObservation: mergeTagRetrievalObservation(info, {
        source: "typescript",
        propagation: tagGraphPropagation,
      }),
    };
  }

  _tagResidualDecompositionSeeds(info: PipelineData): ActivationSeedInput[] {
    const tagResidualDecompositionTags =
      info.tagResidualDecomposition?.levels?.[0]?.tags || [];
    const seeds: ActivationSeedInput[] = [];
    for (const tag of tagResidualDecompositionTags) {
      const id = Number(tag && tag.id);
      if (!Number.isFinite(id)) continue;
      seeds.push({
        id,
        activation: Math.max(0, Number(tag.contribution) || 0) || 1,
        isCore: tag.isCore === true,
        name: tag.name || null,
      });
    }
    return seeds.sort((left, right) => left.id - right.id);
  }

  async _candidateTagSeeds(
    candidates: readonly ChunkCandidate[] | undefined,
    ctx: PipelineContextLike,
  ): Promise<ActivationSeedInput[]> {
    const metadataStore = ctx.metadataStore;
    const resolved = new Map();
    const seeds: ActivationSeedInput[] = [];
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
        if (metadataStore && typeof metadataStore.getTagByName === "function") {
          try {
            tag = await metadataStore.getTagByName(name);
          } catch (e) {
            throw asMemoriaError(
              e,
              "persistence",
              "Metadata store failed while resolving a TagGraphPropagation seed.",
              { retryable: true },
            );
          }
        }
        const id = Number(tag && tag.id);
        if (!Number.isFinite(id)) continue;
        const seed = { id, activation: 1, isCore: false, name };
        resolved.set(name, seed);
        seeds.push(seed);
      }
    }
    return seeds.sort((left, right) => left.id - right.id);
  }

  async _nameIndex(
    ctx: PipelineContextLike,
    info?: PipelineData,
  ): Promise<Map<number, string>> {
    const names = new Map<number, string>();
    const tagResidualDecompositionTags =
      info?.tagResidualDecomposition?.levels?.[0]?.tags || [];
    for (const tag of tagResidualDecompositionTags) {
      const id = Number(tag && tag.id);
      if (Number.isFinite(id) && tag && tag.name) names.set(id, tag.name);
    }
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
        "Metadata store failed while naming TagGraphPropagation tags.",
        { retryable: true },
      );
    }
    for (const row of rows || []) {
      const id = Number(row && row.id);
      if (Number.isFinite(id) && row && row.name) names.set(id, row.name);
    }
    return names;
  }

  _propagateConfig(config: MemoryConfigOverrides): Record<string, unknown> {
    const passthrough: Record<string, unknown> = {};
    const source = config as unknown as Record<string, unknown>;
    for (const key of [
      "propagationMaxHops",
      "routingBudget",
      "shortcutEdgeThreshold",
      "activationThreshold",
      "standardEdgePropagationFactor",
      "shortcutEdgePropagationFactor",
      "maxNeighborsPerNode",
      "returnActivationFactor",
      "hopReadoutGamma",
      "pruneAbove",
      "maxPropagationStates",
      "minimumInjectedActivation",
    ]) {
      if (source[key] !== undefined) passthrough[key] = source[key];
    }
    return passthrough;
  }
}

export default ActivationPropagationStage;
