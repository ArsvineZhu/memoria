'use strict';

const Stage = require('../../core/stage');

/**
 * Embeds document tags via ctx.embeddingProvider.
 * Failed embeddings (null) are filtered out; output keeps
 * { name, vector } entries.
 */
class TagEmbedderStage extends Stage {
  constructor() {
    super();
    this.name = 'tagEmbedder';
  }

  async process(input, ctx) {
    const fileInfo = input;
    const tags = Array.isArray(fileInfo && fileInfo.tags) ? fileInfo.tags : [];

    let vectors = [];
    if (tags.length > 0 && ctx.embeddingProvider) {
      vectors = await ctx.embeddingProvider.embedBatch(tags);
    }

    const tagEntries = [];
    for (let i = 0; i < tags.length; i++) {
      const vector = vectors[i];
      if (vector == null) {
        console.warn(`[TagEmbedder] ⚠️ Skipping tag "${tags[i]}" (embedding failed or null).`);
        continue;
      }
      tagEntries.push({
        name: tags[i],
        vector
      });
    }

    return { ...fileInfo, tagEntries };
  }
}

module.exports = TagEmbedderStage;