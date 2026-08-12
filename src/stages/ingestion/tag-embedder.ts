import type { EmbeddingVector } from "../../types/common.js";
import type { TagEntry } from "../../types/documents.js";
import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";
import { at } from "../../utils/numerical.js";
import { requireCompleteEmbeddingBatch } from "../../utils/embedding-validation.js";

/**
 * Embeds document tags via ctx.embeddingProvider.
 * Every extracted tag must receive one valid vector before the document can
 * continue to the authority writer.
 */
class TagEmbedderStage extends Stage {
  constructor() {
    super();
    this.name = "tagEmbedder";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<Omit<PipelineData, "tagEntries"> & { tagEntries: TagEntry[] }> {
    const fileInfo = input;
    const tags: string[] = Array.isArray(fileInfo.tags) ? fileInfo.tags : [];

    const needsChunkEmbedding = fileInfo.needsChunkEmbedding ?? fileInfo.needsEmbedding;
    if (needsChunkEmbedding === false && fileInfo.needsTagUpdate !== true) {
      return { ...fileInfo, tagEntries: [] };
    }

    let rawVectors: Array<EmbeddingVector | null> = [];
    if (tags.length > 0 && ctx.embeddingProvider) {
      try {
        rawVectors = await ctx.embeddingProvider.embedBatch(tags);
      } catch (error) {
        throw asMemoriaError(
          error,
          "embedding",
          "Embedding provider failed while embedding tags.",
          { retryable: true },
        );
      }
    }

    const vectors = requireCompleteEmbeddingBatch(
      tags,
      rawVectors,
      Number(ctx.config.dimension) || ctx.embeddingProvider?.getDimension() || 0,
      "tag",
    );

    const tagEntries: TagEntry[] = [];
    for (let i = 0; i < tags.length; i++) {
      const vector = at(vectors, i, "tag embeddings");
      tagEntries.push({
        name: at(tags, i, "tags"),
        vector,
      });
    }

    return { ...fileInfo, tagEntries };
  }
}

export default TagEmbedderStage;
