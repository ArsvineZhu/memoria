import type { ChunkCandidate } from "../../types/documents.js";
import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";
import type { TruncationStats } from "../../types/retrieval.js";

import Stage from "../../core/stage.js";

/**
 * Postprocess stage: caps candidate count and content length.
 *
 * The MemoryEngine search returns full chunk text when truncation is disabled,
 * so this stage is opt-in; when enabled it mirrors the classic topK /
 * resultLimit contract: candidates are cut to `topK` (alias `maxResults`)
 * and `content` (and the `text` alias) are sliced to `maxContentLength`
 * characters.
 *
 * Input: { mergedCandidates: [{ chunkId, score, content?, text?, ... }] }
 * Output: { ..., mergedCandidates, truncationStats: { dropped, truncated } }
 *
 * Config (ctx.config):
 *   - truncateEnabled     gate (default false; opt-in)
 *   - truncateMinScore    optional score floor applied after prior rerank/decay
 *   - topK / maxResults    max candidate count (default Infinity)
 *   - maxContentLength     max content chars (default Infinity)
 *   - truncateEllipsis     append '…' to truncated content (default true)
 */
class TruncatorStage extends Stage {
  constructor() {
    super();
    this.name = "truncator";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "mergedCandidates" | "truncationStats"> & {
      mergedCandidates: ChunkCandidate[];
      truncationStats?: TruncationStats;
    }
  > {
    const info = input || {};
    const config = ctx.config || {};
    const candidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];

    if (config.truncateEnabled !== true) {
      return { ...info, mergedCandidates: candidates };
    }

    const topK = Number(info.topK ?? config.topK ?? config.maxResults);
    const maxResults = Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : Infinity;

    const configuredMinScore = Number(config.truncateMinScore);
    const minScore =
      Number.isFinite(configuredMinScore) && configuredMinScore > 0
        ? Math.min(1, configuredMinScore)
        : 0;
    const scoreFilteredCandidates =
      minScore > 0
        ? candidates.filter((candidate) => Number(candidate.score) >= minScore)
        : candidates;
    const scoreFiltered = candidates.length - scoreFilteredCandidates.length;

    const maxContentLength = Number(config.maxContentLength);
    const contentCap =
      Number.isFinite(maxContentLength) && maxContentLength > 0
        ? Math.floor(maxContentLength)
        : Infinity;
    const addEllipsis = config.truncateEllipsis === true;

    let truncated = 0;
    const sliced = scoreFilteredCandidates.slice(0, maxResults).map((candidate) => {
      const trimmed = this._truncateContent(candidate, contentCap, addEllipsis);
      if (trimmed !== candidate) truncated += 1;
      return trimmed;
    });

    return {
      ...info,
      mergedCandidates: sliced,
      truncationStats: {
        dropped: candidates.length - sliced.length,
        truncated,
        scoreFiltered,
      },
    };
  }

  _truncateContent(
    candidate: ChunkCandidate,
    cap: number,
    addEllipsis: boolean,
  ): ChunkCandidate {
    if (candidate.content === undefined && candidate.text === undefined) {
      return candidate;
    }
    if (cap === Infinity) return candidate;

    const content = String(candidate.content ?? "");
    const text = String(candidate.text ?? "");
    const contentTruncated = content.length > cap;
    const textTruncated = text.length > cap;
    if (!contentTruncated && !textTruncated) return candidate;

    const suffix = addEllipsis ? "…" : "";
    return {
      ...candidate,
      ...(contentTruncated ? { content: content.slice(0, cap) + suffix } : {}),
      ...(textTruncated ? { text: text.slice(0, cap) + suffix } : {}),
    };
  }
}

export default TruncatorStage;
