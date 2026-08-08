'use strict';

const Stage = require('../../core/stage');

/**
 * Output stage: assembles the final TDB search result array.
 *
 * Mirrors the hydrated result shape returned by
 * TDBKnowledge._searchLibraryUnlocked:
 *
 *   {
 *     library, id, score, payload,
 *     text, sourceFile, chunkIndex
 *   }
 *
 * Candidates are resolved through ctx.metadataStore (getChunkById → file
 * lineage), so the library / path / chunk_index attributes of the stored
 * facts are attached. Candidates without a matching chunk row (stale
 * vector entries) are dropped.
 *
 * Input:  { query, mergedCandidates }
 * Output: { ..., results: [...], resultCount }
 */
class TDBResultFormatterStage extends Stage {
  constructor() {
    super();
    this.name = 'tdbResultFormatter';
  }

  async process(input, ctx) {
    const info = input || {};
    const candidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];
    const store = ctx.metadataStore;

    const results = [];
    for (const candidate of candidates) {
      const formatted = await this._formatCandidate(candidate, store);
      if (formatted) results.push(formatted);
    }
    results.sort(
      (a, b) => (b.score - a.score) || (Number(a.id) - Number(b.id))
    );

    return { ...info, results, resultCount: results.length };
  }

  async _formatCandidate(candidate, store) {
    const chunkId = Number(candidate && candidate.chunkId);
    if (!Number.isFinite(chunkId)) return null;

    let chunk = null;
    if (store && typeof store.getChunkById === 'function') {
      try {
        chunk = await store.getChunkById(chunkId);
      } catch (_) {
        chunk = null;
      }
    }
    if (!chunk) return null;

    let file = null;
    if (store && typeof store.getFileByChunkId === 'function') {
      try {
        file = await store.getFileByChunkId(chunk.id);
      } catch (_) {
        file = null;
      }
    }

    const score = Number(candidate && candidate.score) || 0;
    const decay = Number.isFinite(Number(candidate && candidate.decay))
      ? Number(candidate.decay)
      : undefined;

    return {
      id: chunk.id,
      chunkId: chunk.id,
      library: (file && file.library) || chunk.library || null,
      path: chunk.path || (file && file.path) || '',
      sourceFile: chunk.path || '',
      chunkIndex: Number.isFinite(Number(chunk.chunkIndex)) ? chunk.chunkIndex : null,
      text: chunk.text || '',
      score,
      similarity: score,
      decay,
      checksum: chunk.checksum,
      payload: {
        library: (file && file.library) || chunk.library || null,
        source_path: chunk.path || '',
        text_preview: String(chunk.text || '').slice(0, 500),
        chunk_index: chunk.chunkIndex,
        checksum: chunk.checksum
      }
    };
  }
}

module.exports = TDBResultFormatterStage;