
import type {
  EmbeddingVector,
  PipelineContextLike,
  PipelineData,
  ChunkEntry,
} from '../../types';

import Stage = require('../../core/stage');

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

  async process(input: PipelineData, ctx: PipelineContextLike): Promise<Omit<PipelineData, 'chunkEntries'> & { chunkEntries: ChunkEntry[] }> {
    const fileInfo = input;
    const chunks: string[] = Array.isArray(fileInfo.chunks) ? fileInfo.chunks : [];

    let vectors: Array<EmbeddingVector | null> = [];
    if (chunks.length > 0 && ctx.embeddingProvider) {
      vectors = await ctx.embeddingProvider.embedBatch(chunks);
    }

    const chunkEntries: ChunkEntry[] = [];
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

export = ChunkEmbedderStage;
