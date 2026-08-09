import type {
  EmbeddingVector,
  PipelineContextLike,
  PipelineData,
  ChunkEntry,
} from "../../types.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";
import { at } from "../../utils/numerical.js";

/**
 * Embeds document chunks via ctx.embeddingProvider.
 * Failed embeddings (null) are filtered out; output keeps
 * { chunkIndex, content, vector } entries aligned with the chunk order.
 */
class ChunkEmbedderStage extends Stage {
  constructor() {
    super();
    this.name = "chunkEmbedder";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<Omit<PipelineData, "chunkEntries"> & { chunkEntries: ChunkEntry[] }> {
    const fileInfo = input;
    const chunks: string[] = Array.isArray(fileInfo.chunks) ? fileInfo.chunks : [];

    let vectors: Array<EmbeddingVector | null> = [];
    if (chunks.length > 0 && ctx.embeddingProvider) {
      try {
        vectors = await ctx.embeddingProvider.embedBatch(chunks);
      } catch (error) {
        throw asMemoriaError(
          error,
          "embedding",
          "Embedding provider failed while embedding document chunks.",
          { retryable: true },
        );
      }
    }

    const chunkEntries: ChunkEntry[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const vector = at(vectors, i, "chunk embeddings");
      if (vector == null) {
        console.warn(
          `[ChunkEmbedder] ⚠️ Skipping chunk ${i} (embedding failed or null).`,
        );
        continue;
      }
      chunkEntries.push({
        chunkIndex: i,
        content: at(chunks, i, "chunks"),
        vector,
      });
    }

    return { ...fileInfo, chunkEntries };
  }
}

export default ChunkEmbedderStage;
