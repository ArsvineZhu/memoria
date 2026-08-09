import type {
  EmbeddingVector,
  PipelineContextLike,
  PipelineData,
  TagEntry,
} from "../../types.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";
import { at } from "../../utils/numerical.js";

/**
 * Embeds document tags via ctx.embeddingProvider.
 * Failed embeddings (null) are filtered out; output keeps
 * { name, vector } entries.
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

    let vectors: Array<EmbeddingVector | null> = [];
    if (tags.length > 0 && ctx.embeddingProvider) {
      try {
        vectors = await ctx.embeddingProvider.embedBatch(tags);
      } catch (error) {
        throw asMemoriaError(
          error,
          "embedding",
          "Embedding provider failed while embedding tags.",
          { retryable: true },
        );
      }
    }

    const tagEntries: TagEntry[] = [];
    for (let i = 0; i < tags.length; i++) {
      const vector = at(vectors, i, "tag embeddings");
      if (vector == null) {
        console.warn(
          `[TagEmbedder] ⚠️ Skipping tag "${at(tags, i, "tags")}" (embedding failed or null).`,
        );
        continue;
      }
      tagEntries.push({
        name: at(tags, i, "tags"),
        vector,
      });
    }

    return { ...fileInfo, tagEntries };
  }
}

export default TagEmbedderStage;
