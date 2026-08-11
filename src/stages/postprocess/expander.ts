import type {
  ChunkRow,
  ChunkCandidate,
  ExpansionStats,
  PipelineContextLike,
  PipelineData,
} from "../../types.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";
import { at } from "../../utils/numerical.js";

/**
 * Postprocess stage: expands final results with related same-file chunks or
 * the materialised body of the parent document.
 *
 * The original KnowledgeBase search() does not attach an association /
 * expansion layer to its result assembly, so this stage is config-gated off
 * by default. When enabled it mirrors the "related memory" pattern used by
 * the associate/expand flows elsewhere in the project (e.g. DailyNote
 * association): for the top `expandCount` candidates, sibling chunks of the
 * same file are appended with their base score scaled by `expansionBoost`.
 * `fullDocumentExpansionEnabled` keeps the seed row and replaces its body
 * with the ordered parent-document body, matching VCP's old `Expand` output
 * without introducing synthetic chunk IDs.
 *
 * Input: { mergedCandidates: [{ chunkId, score, ... }] }
 * Output: { ..., mergedCandidates (re-sorted desc), expansionStats }
 *
 * Config (ctx.config):
 *   - expansionEnabled     gate (default false)
 *   - expandCount          how many top candidates seed expansion (default 2)
 *   - expansionBoost       score multiplier for expanded siblings (default 0.5)
 *   - expandSameFile       expand within the same file (default true)
 *   - fullDocumentExpansionEnabled  materialise the full parent body
 */
class ExpanderStage extends Stage {
  constructor() {
    super();
    this.name = "expander";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "mergedCandidates" | "expansionStats"> & {
      mergedCandidates: ChunkCandidate[];
      expansionStats?: ExpansionStats;
    }
  > {
    const info = input || {};
    const config = ctx.config || {};
    const candidates: ChunkCandidate[] = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];
    const resolvedScope = Array.isArray(info.resolvedIndexNames)
      ? new Set(info.resolvedIndexNames.map((name) => String(name)))
      : null;
    const allowedChunkIds =
      info.allowedChunkIds instanceof Set ? info.allowedChunkIds : null;

    const expandCount = Math.max(0, Math.round(Number(config.expandCount) || 2));
    const baseBoost = Number(config.expansionBoost);

    // Default boost mirrors the weight used by associate-style expansion of
    // related memories (half the original score).
    const expansionBoost = Number.isFinite(baseBoost) ? baseBoost : 0.5;

    if (
      config.expansionEnabled !== true ||
      typeof ctx.metadataStore?.getFileByChunkId !== "function" ||
      typeof ctx.metadataStore?.getChunksByFileId !== "function" ||
      candidates.length === 0
    ) {
      return { ...info, mergedCandidates: candidates, expansionStats: { added: 0 } };
    }

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
      return { ...info, mergedCandidates: [], expansionStats: { added: 0 } };
    }

    const result: ChunkCandidate[] = [];
    const presentIds = new Set();
    for (const candidate of scopedCandidates) {
      result.push(candidate);
      presentIds.add(Number(candidate && candidate.chunkId));
    }

    let added = 0;
    let documentsExpanded = 0;
    const seedCount = Math.min(expandCount, scopedCandidates.length);
    const fullDocument = config.fullDocumentExpansionEnabled === true;
    for (let index = 0; index < seedCount; index += 1) {
      const seed = at(scopedCandidates, index, "expansion candidates");
      const seedChunkId = Number(seed && seed.chunkId);
      if (!Number.isFinite(seedChunkId)) continue;

      let file;
      try {
        file = await ctx.metadataStore.getFileByChunkId(seedChunkId);
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Metadata store failed while expanding a search file.",
          { retryable: true },
        );
      }
      if (!file) continue;

      let siblings: ChunkRow[] | null = null;
      try {
        siblings = await ctx.metadataStore.getChunksByFileId(file.id);
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Metadata store failed while loading expanded search chunks.",
          { retryable: true },
        );
      }
      if (!Array.isArray(siblings)) continue;

      if (fullDocument) {
        const inScopeSiblings: ChunkRow[] = [];
        for (const sibling of siblings) {
          const siblingId = Number(sibling && sibling.id);
          if (
            !Number.isFinite(siblingId) ||
            !(await this._chunkInScope(siblingId, allowedChunkIds, resolvedScope, ctx))
          ) {
            continue;
          }
          inScopeSiblings.push(sibling);
        }
        inScopeSiblings.sort(
          (left, right) =>
            Number(left?.chunk_index ?? left?.chunkIndex ?? 0) -
              Number(right?.chunk_index ?? right?.chunkIndex ?? 0) ||
            Number(left?.id ?? 0) - Number(right?.id ?? 0),
        );
        const parts = inScopeSiblings
          .map((sibling) => String(sibling?.content ?? ""))
          .filter(Boolean);
        if (parts.length > 0) {
          const fullContent = parts.join("\n\n");
          const resultIndex = result.findIndex(
            (candidate) => Number(candidate.chunkId) === seedChunkId,
          );
          if (resultIndex >= 0) {
            const seedResult = result[resultIndex];
            if (!seedResult) continue;
            result[resultIndex] = {
              ...seedResult,
              content: fullContent,
              text: fullContent,
              source: "expansion-full-document",
              expandedDocument: true,
              expandedDocumentComplete: inScopeSiblings.length === siblings.length,
              expandedFileId: file.id,
              expandedPath: file.path,
            };
            documentsExpanded += 1;
          }
        }
        continue;
      }

      for (const sibling of siblings) {
        const siblingId: number = Number(sibling && sibling.id);
        if (!Number.isFinite(siblingId) || presentIds.has(siblingId)) continue;
        if (
          !(await this._chunkInScope(siblingId, allowedChunkIds, resolvedScope, ctx))
        ) {
          continue;
        }
        result.push({
          chunkId: siblingId,
          score: (seed.score || 0) * expansionBoost,
          source: "expansion",
          expansionOf: seedChunkId,
        });
        presentIds.add(siblingId);
        added += 1;
      }
    }

    result.sort((a, b) => b.score - a.score || Number(a.chunkId) - Number(b.chunkId));

    return {
      ...info,
      mergedCandidates: result,
      expansionStats: {
        added,
        documentsExpanded,
        mode: fullDocument ? "full-document" : "chunks",
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

export default ExpanderStage;
