
import type { PipelineContextLike, PipelineData } from '../../types';

import Stage = require('../../core/stage');
import { chunkText } from '../../utils/text-chunker';
import type { ChunkOptions } from '../../utils/text-chunker';
import { prepareTextForEmbedding, EMPTY_CONTENT } from '../../utils/text-preprocessor';

/**
 * Splits document content into embedding-ready chunks.
 * Mirrors ingestionPipeline._flushBatch: raw chunkText output is normalized
 * via prepareTextForEmbedding and empty chunks are dropped.
 */
class ChunkerStage extends Stage {
  constructor() {
    super();
    this.name = 'chunker';
  }

  async process(input: PipelineData, ctx: PipelineContextLike): Promise<Omit<PipelineData, 'chunks'> & { chunks: string[] }> {
    const fileInfo = input;
    if (!fileInfo || typeof fileInfo.content !== 'string') {
      return { ...(fileInfo || {}), chunks: [] };
    }

    const config = ctx.config;
    const maxTokens = config.chunkMaxTokens || config.maxTokens || undefined;
    const overlapTokens = config.chunkOverlapTokens || config.overlapTokens || undefined;

    const options: ChunkOptions = {};
    if (typeof maxTokens === 'number') options.maxTokens = maxTokens;
    if (typeof overlapTokens === 'number') options.overlapTokens = overlapTokens;

    const chunks = chunkText(fileInfo.content, options)
      .map(text => prepareTextForEmbedding(text))
      .filter(text => text !== EMPTY_CONTENT);

    return { ...fileInfo, chunks };
  }
}

export = ChunkerStage;
