import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";

import Stage from "../../core/stage.js";
import { extractTags } from "../../utils/text-preprocessor.js";

/**
 * Extracts tags from document content (Tag: lines at the end of the file).
 * Uses config.tagBlacklist / config.tagBlacklistSuper and limits the count
 * via config.maxTagsPerFile.
 */
class TagExtractorStage extends Stage {
  constructor() {
    super();
    this.name = "tagExtractor";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<Omit<PipelineData, "tags"> & { tags: string[] }> {
    const fileInfo = input;
    if (!fileInfo || typeof fileInfo.content !== "string") {
      return { ...(fileInfo || {}), tags: [] };
    }

    const config = ctx.config || {};
    const metadataTags = fileInfo.documentMetadata?.tags;
    const extraTags =
      typeof metadataTags === "string"
        ? [metadataTags]
        : Array.isArray(metadataTags)
          ? metadataTags
          : [];
    const tags = extractTags(fileInfo.content, config, {
      maxTags: config.maxTagsPerFile || 50,
      extraTags,
    });

    let needsTagUpdate = fileInfo.needsTagUpdate === true;
    if (ctx.metadataStore && typeof fileInfo.relPath === "string") {
      const existing = await ctx.metadataStore.getFileByPath(fileInfo.relPath);
      if (existing) {
        const existingTags = await ctx.metadataStore.getFileTags(existing.id);
        const existingNames = existingTags.map((tag) => tag.name || "");
        needsTagUpdate =
          needsTagUpdate ||
          existingNames.length !== tags.length ||
          existingNames.some((name, index) => name !== tags[index]);
      }
    }

    return { ...fileInfo, tags, needsTagUpdate };
  }
}

export default TagExtractorStage;
