'use strict';

const Stage = require('../../core/stage');
const { extractTags } = require('../../utils/text-preprocessor');

/**
 * Extracts tags from document content (Tag: lines at the end of the file).
 * Uses config.tagBlacklist / config.tagBlacklistSuper and limits the count
 * via config.maxTagsPerFile, mirroring KnowledgeBaseManager._extractTags.
 */
class TagExtractorStage extends Stage {
  constructor() {
    super();
    this.name = 'tagExtractor';
  }

  async process(input, ctx) {
    const fileInfo = input;
    if (!fileInfo || typeof fileInfo.content !== 'string') {
      return { ...(fileInfo || {}), tags: [] };
    }

    const config = ctx.config || {};
    const tags = extractTags(fileInfo.content, config, {
      maxTags: config.maxTagsPerFile || 50
    });

    return { ...fileInfo, tags };
  }
}

module.exports = TagExtractorStage;