import type { ChunkCandidate, PipelineContextLike, PipelineData } from "../../types.js";

import Stage from "../../core/stage.js";
import { RelationGraphStore } from "../../retrieval/relation-graph.js";

/** Expand candidates through explicit and derived memory relations. */
class RelationExpansionStage extends Stage {
  constructor() {
    super();
    this.name = "relationExpansion";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<PipelineData> {
    const info = input || {};
    const candidates = Array.isArray(info.mergedCandidates)
      ? (info.mergedCandidates as ChunkCandidate[])
      : [];
    const config = ctx.config || {};
    const resolvedScope = Array.isArray(info.resolvedIndexNames)
      ? new Set(info.resolvedIndexNames.map((name) => String(name)))
      : null;
    const allowedChunkIds =
      info.allowedChunkIds instanceof Set ? info.allowedChunkIds : null;
    if (
      config.relationExpansionEnabled !== true ||
      candidates.length === 0 ||
      !ctx.metadataStore
    ) {
      return { ...info, mergedCandidates: candidates, relationExpansionSkipped: true };
    }

    // Apply the hard scope before graph traversal. The final candidate filter
    // remains in the pipeline as a defense in depth, but out-of-scope chunks
    // must not become seeds or participate in score propagation.
    const scopedCandidates: ChunkCandidate[] = [];
    for (const candidate of candidates) {
      if (
        await this._chunkInScope(
          Number(candidate.chunkId),
          allowedChunkIds,
          resolvedScope,
          ctx,
        )
      ) {
        scopedCandidates.push(candidate);
      }
    }
    if (scopedCandidates.length === 0) {
      return {
        ...info,
        mergedCandidates: [],
        relationExpansion: { added: 0, maxHops: 0, seedCount: 0 },
      };
    }

    const seedCount = Math.max(
      1,
      Math.min(
        scopedCandidates.length,
        Math.round(Number(config.relationExpansionSeeds) || 3),
      ),
    );
    const maxHops = Math.max(
      0,
      Math.min(
        8,
        Math.round(Number(config.relationMaxHops ?? config.topologyMaxHops) || 1),
      ),
    );
    const maxAdded = Math.max(
      0,
      Math.round(Number(config.relationMaxAdded ?? config.expandCount) || 50),
    );
    const boost = Number.isFinite(Number(config.relationExpansionBoost))
      ? Number(config.relationExpansionBoost)
      : 0.75;
    const seeds = scopedCandidates.slice(0, seedCount);
    const related = await new RelationGraphStore(ctx.metadataStore).relatedChunks(
      seeds.map((candidate) => Number(candidate.chunkId)).filter(Number.isFinite),
      maxHops,
      maxAdded,
    );
    const existing = new Set(
      scopedCandidates.map((candidate) => Number(candidate.chunkId)),
    );
    const additions: ChunkCandidate[] = [];
    for (const relation of related) {
      if (existing.has(relation.chunkId)) continue;
      if (
        !(await this._chunkInScope(
          relation.chunkId,
          allowedChunkIds,
          resolvedScope,
          ctx,
        ))
      ) {
        continue;
      }
      const seed = seeds[Math.min(relation.distance - 1, seeds.length - 1)];
      const seedScore = Number(seed?.score) || 0;
      const score = Math.max(
        0,
        Math.min(
          1,
          seedScore *
            boost *
            relation.confidence *
            Math.pow(0.7, relation.distance - 1),
        ),
      );
      additions.push({
        chunkId: relation.chunkId,
        score,
        source: "relation-expansion",
        relationDistance: relation.distance,
        relationConfidence: relation.confidence,
        relationIds: relation.relationIds,
      });
      existing.add(relation.chunkId);
      if (additions.length >= maxAdded) break;
    }
    const mergedCandidates = [...scopedCandidates, ...additions].sort(
      (left, right) =>
        Number(right.score) - Number(left.score) ||
        Number(left.chunkId) - Number(right.chunkId),
    );
    return {
      ...info,
      mergedCandidates,
      relationExpansion: {
        added: additions.length,
        maxHops,
        seedCount: seeds.length,
      },
    };
  }

  private async _chunkInScope(
    chunkId: number,
    allowedChunkIds: Set<unknown> | null,
    resolvedScope: Set<string> | null,
    ctx: PipelineContextLike,
  ): Promise<boolean> {
    if (allowedChunkIds) {
      return allowedChunkIds.has(chunkId) || allowedChunkIds.has(String(chunkId));
    }
    if (resolvedScope === null) return true;
    if (
      resolvedScope.size === 0 ||
      typeof ctx.metadataStore?.getFileByChunkId !== "function"
    ) {
      return false;
    }
    const file = await ctx.metadataStore.getFileByChunkId(chunkId);
    const space = file?.diary_name || file?.diaryName || "Root";
    return !!file && resolvedScope.has(String(space));
  }
}

export default RelationExpansionStage;
