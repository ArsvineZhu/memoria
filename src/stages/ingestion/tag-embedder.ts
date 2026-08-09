
import type {
  EmbeddingVector,
  PipelineContextLike,
  PipelineData,
  TagEntry,
} from '../../types';

import Stage = require('../../core/stage');

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

  async process(input: PipelineData, ctx: PipelineContextLike): Promise<Omit<PipelineData, 'tagEntries'> & { tagEntries: TagEntry[] }> {
    const fileInfo = input;
    const tags: string[] = Array.isArray(fileInfo.tags) ? fileInfo.tags : [];

    let vectors: Array<EmbeddingVector | null> = [];
    if (tags.length > 0 && ctx.embeddingProvider) {
      vectors = await ctx.embeddingProvider.embedBatch(tags);
    }

    const tagEntries: TagEntry[] = [];
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

export = TagEmbedderStage;
