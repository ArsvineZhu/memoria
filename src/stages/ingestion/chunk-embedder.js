'use strict';

const Stage = require('../../core/stage');

/**
 * Embeds document chunks via ctx.embeddingProvider.
 * Failed embeddings (null) are filtered out; output keeps
 * { chunkIndex, content, vector } entries aligned with the chunk order.
 */
class ChunkEmbedderStage extends Stage {
  constructor() {
    super();
    this.name = 'chunkEmbedder';
  }

  async process(input, ctx) {
    const fileInfo = input;
    const chunks = Array.isArray(fileInfo && fileInfo.chunks) ? fileInfo.chunks : [];

    let vectors = [];
    if (chunks.length > 0 && ctx.embeddingProvider) {
      vectors = await ctx.embeddingProvider.embedBatch(chunks);
    }

    const chunkEntries = [];
    for (let i = 0; i < chunks.length; i++) {
      const vector = vectors[i];
      if (vector == null) {
        console.warn(`[ChunkEmbedder] ⚠️ Skipping chunk ${i} (embedding failed or null).`);
        continue;
      }
      chunkEntries.push({
        chunkIndex: i,
        content: chunks[i],
        vector
      });
    }

    return { ...fileInfo, chunkEntries };
  }
}

module.exports = ChunkEmbedderStage;