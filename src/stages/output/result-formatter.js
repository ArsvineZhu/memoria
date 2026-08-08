'use strict';

const Stage = require('../../core/stage');
const path = require('path');

/**
 * Output stage: assembles the final search result array.
 *
 * Mirrors the hydrated result shape returned by
 * modules/knowledgeBase/searchService.js (chunk text, path, per-chunk tags,
 * score) while normalizing field names:
 *
 *   {
 *     id, chunkId, content, path, sourceFile, fileId, diaryName,
 *     score, similarity, updatedAt, mtime, tags, matchedTags,
 *     memoScore, source, decay, rerankScore, original_score(s)
 *   }
 *
 * Missing fields are hydrated from ctx.metadataStore via getChunkById /
 * getFileByChunkId / getFileTags. Candidates that already carry complete
 * field values pass through unharmed. TagMemo / EPA / pyramid traces in the
 * input are preserved on the output envelope.
 *
 * Input: { query, mergedCandidates, tagMemo?, pyramid?, epa? }
 * Output: { ..., results: [...], resultCount }
 */
class ResultFormatterStage extends Stage {
  constructor() {
    super();
    this.name = 'resultFormatter';
  }

  async process(input, ctx) {
    const info = input || {};
    const candidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];
    const store = ctx.metadataStore;

    const results = [];
    for (const candidate of candidates) {
      results.push(await this._formatCandidate(candidate, ctx, store));
    }
    results.sort(
      (a, b) => (b.score - a.score) || (Number(a.id) - Number(b.id))
    );

    return { ...info, results, resultCount: results.length };
  }

  async _formatCandidate(candidate, ctx, store) {
    const chunkId = Number(candidate && candidate.chunkId);
    const id = Number.isFinite(chunkId)
      ? chunkId
      : Number(candidate && candidate.id) || null;

    let chunk = null;
    let file = null;
    if (Number.isFinite(id) && store && typeof store.getChunkById === 'function') {
      try {
        chunk = await store.getChunkById(id);
      } catch (error) {
        chunk = null;
      }
    }
    if (chunk && store && typeof store.getFileByChunkId === 'function') {
      try {
        file = await store.getFileByChunkId(chunk.id);
      } catch (error) {
        file = null;
      }
    }

    const content = candidate?.content ?? candidate?.text ?? chunk?.content ?? '';
    const fullPath = file?.path ?? candidate?.path ?? candidate?.fullPath ?? '';

    let tags = candidate?.tags;
    if (!Array.isArray(tags) && file && store && typeof store.getFileTags === 'function') {
      try {
        const tagRows = await store.getFileTags(file.id);
        tags = Array.isArray(tagRows)
          ? tagRows.map(t => (t && t.name) || String(t))
          : [];
      } catch (error) {
        tags = [];
      }
    }
    if (!Array.isArray(tags)) {
      tags = Array.isArray(candidate?.matchedTags)
        ? candidate.matchedTags
        : [];
    }

    const score = Number(candidate?.score) || 0;

    return {
      id,
      chunkId: Number.isFinite(chunkId) ? chunkId : id,
      content,
      path: fullPath,
      sourceFile: fullPath ? path.basename(fullPath) : candidate?.sourceFile || '',
      fileId: file?.id ?? candidate?.fileId ?? candidate?._fileId ?? null,
      diaryName: file?.diary_name ?? candidate?.diaryName ?? '',
      score,
      similarity: Number.isFinite(Number(candidate?.similarity))
        ? Number(candidate.similarity)
        : score,
      updatedAt: file?.updated_at ?? candidate?.updatedAt ?? candidate?.updated_at ?? null,
      mtime: file?.mtime ?? candidate?.mtime ?? null,
      tags,
      matchedTags: candidate?.matchedTags ?? tags,
      memoScore: Number.isFinite(Number(candidate?.memoScore))
        ? Number(candidate.memoScore)
        : Number.isFinite(Number(candidate?.tagMatchScore))
          ? Number(candidate.tagMatchScore)
          : undefined,
      source: candidate?.source ?? null,
      decay: Number.isFinite(Number(candidate?.decay))
        ? Number(candidate.decay)
        : undefined,
      rerankScore: Number.isFinite(Number(candidate?.rerankScore))
        ? Number(candidate.rerankScore)
        : undefined
    };
  }
}

module.exports = ResultFormatterStage;