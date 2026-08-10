import type {
  EmbeddingVector,
  PipelineContextLike,
  PipelineData,
  ChunkEntry,
} from "../../types.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";
import { at } from "../../utils/numerical.js";
import { requireCompleteEmbeddingBatch } from "../../utils/embedding-validation.js";

/**
 * Embeds document chunks via ctx.embeddingProvider.
 * Every input chunk must receive one valid vector before the document can
 * continue to the authority writer.
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

    const needsChunkEmbedding = fileInfo.needsChunkEmbedding ?? fileInfo.needsEmbedding;
    if (needsChunkEmbedding === false) {
      return { ...fileInfo, chunkEntries: [] };
    }

    let rawVectors: Array<EmbeddingVector | null> = [];
    if (chunks.length > 0 && ctx.embeddingProvider) {
      try {
        rawVectors = await ctx.embeddingProvider.embedBatch(chunks);
      } catch (error) {
        throw asMemoriaError(
          error,
          "embedding",
          "Embedding provider failed while embedding document chunks.",
          { retryable: true },
        );
      }
    }

    const vectors = requireCompleteEmbeddingBatch(
      chunks,
      rawVectors,
      Number(ctx.config.dimension) || ctx.embeddingProvider?.getDimension() || 0,
      "chunk",
    );

    const chunkEntries: ChunkEntry[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const vector = at(vectors, i, "chunk embeddings");
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
