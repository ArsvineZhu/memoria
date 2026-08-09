import type { PipelineContextLike, PipelineData } from "../../types.js";

import Stage from "../../core/stage.js";
import { extractTags } from "../../utils/text-preprocessor.js";

/**
 * Extracts tags from document content (Tag: lines at the end of the file).
 * Uses config.tagBlacklist / config.tagBlacklistSuper and limits the count
 * via config.maxTagsPerFile, mirroring KnowledgeBaseManager._extractTags.
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
    const tags = extractTags(fileInfo.content, config, {
      maxTags: config.maxTagsPerFile || 50,
    });

    return { ...fileInfo, tags };
  }
}

export default TagExtractorStage;
