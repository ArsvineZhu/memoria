import type { ChunkCandidate } from "../../types/documents.js";
import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";
import type { AssociatorStats } from "../../types/retrieval.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";
import { collectTagProposals, canUseTagChannel } from "./associator-tag-channel.js";
import {
  collectVectorProposals,
  canUseVectorChannel,
} from "./associator-vector-channel.js";
import { compareProposals, mergeCandidates } from "./associator-ranking.js";
import { chunkInScope, positiveInteger } from "./associator-scope.js";
import type { AssociationProposal } from "./associator-types.js";

const DEFAULT_ASSOCIATE_COUNT = 10;
const DEFAULT_SEED_COUNT = 3;

/**
 * Stage facade for association orchestration. Channel-specific persistence
 * and vector work live in sibling modules; this class owns only pipeline
 * gating, seed selection, proposal arbitration, and output shape.
 */
class AssociatorStage extends Stage {
  constructor() {
    super();
    this.name = "associator";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "mergedCandidates" | "associatorStats"> & {
      mergedCandidates: ChunkCandidate[];
      associatorStats: AssociatorStats;
      associatorSkipped?: boolean;
    }
  > {
    const info = input || {};
    let candidates = Array.isArray(info.mergedCandidates) ? info.mergedCandidates : [];
    const resolvedScope = Array.isArray(info.resolvedIndexNames)
      ? new Set(info.resolvedIndexNames.map((name) => String(name)))
      : null;
    const allowedChunkIds =
      info.allowedChunkIds instanceof Set ? info.allowedChunkIds : null;
    const stats: AssociatorStats = {
      added: 0,
      fromTags: 0,
      fromVector: 0,
      skipped: 0,
    };

    if (resolvedScope?.size === 0) {
      return {
        ...info,
        mergedCandidates: [],
        associatorStats: stats,
        associatorSkipped: true,
      };
    }
    if (ctx.config?.associatorEnabled !== true || candidates.length === 0) {
      return {
        ...info,
        mergedCandidates: candidates,
        associatorStats: stats,
        associatorSkipped: true,
      };
    }

    const config = ctx.config || {};
    const seedCount = positiveInteger(config.associatorSeeds, DEFAULT_SEED_COUNT, true);
    const associateCount = positiveInteger(
      config.associateCount,
      DEFAULT_ASSOCIATE_COUNT,
      true,
    );
    if (resolvedScope !== null) {
      const scopedCandidates: ChunkCandidate[] = [];
      for (const candidate of candidates) {
        if (
          await chunkInScope(
            Number(candidate.chunkId),
            resolvedScope,
            allowedChunkIds,
            ctx,
          )
        ) {
          scopedCandidates.push(candidate);
        }
      }
      candidates = scopedCandidates;
    }
    if (candidates.length === 0) {
      return {
        ...info,
        mergedCandidates: [],
        associatorStats: stats,
        associatorSkipped: true,
      };
    }
    const seeds = candidates.slice(0, seedCount);
    if (seeds.length === 0 || associateCount === 0) {
      return {
        ...info,
        mergedCandidates: candidates,
        associatorStats: stats,
        associatorSkipped: true,
      };
    }

    const presentIds = new Set<number>();
    for (const candidate of candidates) {
      const chunkId = Number(candidate && candidate.chunkId);
      if (Number.isFinite(chunkId)) presentIds.add(chunkId);
    }
    const proposals = new Map<number, AssociationProposal>();
    const metadataStore = ctx.metadataStore;
    const channelContext = {
      scope: resolvedScope,
      allowedChunkIds,
      ctx,
      proposals,
      presentIds,
      stats,
    };

    const tagChannelAvailable = canUseTagChannel(metadataStore);
    if (tagChannelAvailable && resolvedScope !== null) {
      let matrix: Map<number, Map<number, number>>;
      try {
        matrix = await metadataStore!.buildCooccurrenceMatrix!();
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Metadata store failed while building associator co-occurrence data.",
          { retryable: true },
        );
      }
      if (!(matrix instanceof Map)) matrix = new Map();
      for (const seed of seeds) {
        await collectTagProposals(seed, matrix, channelContext, config);
      }
    } else {
      stats.skipped += seeds.length;
    }

    if (config.associatorUseVector !== false) {
      if (canUseVectorChannel(ctx, resolvedScope)) {
        for (const seed of seeds) {
          await collectVectorProposals(seed, channelContext, config);
        }
      } else {
        stats.skipped += seeds.length;
      }
    }

    const selected = [...proposals.values()]
      .sort((left, right) => compareProposals(left, right))
      .slice(0, associateCount);
    if (selected.length === 0) {
      return {
        ...info,
        mergedCandidates: candidates,
        associatorStats: stats,
        ...(stats.skipped > 0 ? { associatorSkipped: true } : {}),
      };
    }

    for (const proposal of selected) {
      if (proposal.channel === "tag") stats.fromTags += 1;
      else stats.fromVector += 1;
    }
    stats.added = selected.length;
    return {
      ...info,
      mergedCandidates: mergeCandidates(candidates, selected),
      associatorStats: stats,
      ...(stats.skipped > 0 ? { associatorSkipped: true } : {}),
    };
  }
}

export default AssociatorStage;
