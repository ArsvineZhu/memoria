'use strict';

const Stage = require('../../core/stage');

/**
 * Postprocess stage: caps candidate count and content length.
 *
 * The original KnowledgeBase search returns full chunk text (no truncation),
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
 *   - topK / maxResults    max candidate count (default Infinity)
 *   - maxContentLength     max content chars (default Infinity)
 *   - truncateEllipsis     append '…' to truncated content (default true)
 */
class TruncatorStage extends Stage {
  constructor() {
    super();
    this.name = 'truncator';
  }

  async process(input, ctx) {
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

    const maxContentLength = Number(config.maxContentLength);
    const contentCap = Number.isFinite(maxContentLength) && maxContentLength > 0
      ? Math.floor(maxContentLength)
      : Infinity;
    const addEllipsis = config.truncateEllipsis === true;

    let truncated = 0;
    const sliced = candidates.slice(0, maxResults).map(candidate => {
      const trimmed = this._truncateContent(candidate, contentCap, addEllipsis);
      if (trimmed !== candidate) truncated += 1;
      return trimmed;
    });

    return {
      ...info,
      mergedCandidates: sliced,
      truncationStats: {
        dropped: candidates.length - sliced.length,
        truncated
      }
    };
  }

  _truncateContent(candidate, cap, addEllipsis) {
    if (
      candidate.content === undefined
      && candidate.text === undefined
    ) {
      return candidate;
    }
    if (cap === Infinity) return candidate;

    const content = String(candidate.content ?? '');
    const text = String(candidate.text ?? '');
    const contentTruncated = content.length > cap;
    const textTruncated = text.length > cap;
    if (!contentTruncated && !textTruncated) return candidate;

    const suffix = addEllipsis ? '…' : '';
    return {
      ...candidate,
      ...(contentTruncated
        ? { content: content.slice(0, cap) + suffix }
        : {}),
      ...(textTruncated ? { text: text.slice(0, cap) + suffix } : {})
    };
  }
}

module.exports = TruncatorStage;