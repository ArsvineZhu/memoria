'use strict';

import Pipeline = require('../core/pipeline');
import FileReaderStage = require('../stages/ingestion/file-reader');
import TagExtractorStage = require('../stages/ingestion/tag-extractor');
import ChunkerStage = require('../stages/ingestion/text-chunker');
import ChunkEmbedderStage = require('../stages/ingestion/chunk-embedder');
import TagEmbedderStage = require('../stages/ingestion/tag-embedder');
import MetadataWriterStage = require('../stages/ingestion/metadata-writer');
import VectorIndexerStage = require('../stages/ingestion/vector-indexer');
import CooccurrenceBuilderStage = require('../stages/ingestion/co-occurrence-builder');
import type { MemoryConfigOverrides, PipelineData } from '../types';
import Stage = require('../core/stage');

interface PipelineOptions {
  stages?: Stage[];
}

/**
 * IngestPipeline — one-file ingestion chain.
 *
 * Mirrors the KnowledgeBaseManager._flushBatch flow for a single file:
 * read → tag extraction → chunking → embedding (chunks + tags) →
 * metadata persistence → vector indexing → optional co-occurrence update.
 *
 * The stage chain is fixed (every ingestion stage is mandatory in the
 * original flow); `options.stages` exists for short-circuiting / tests.
 *
 * Usage:
 *   const pipeline = new IngestPipeline(config);
 *   const result = await pipeline.run({ path: '/abs/path/note.md' }, ctx);
 *   // ctx: PipelineContext with metadataStore, vectorStore,
 *   //      embeddingProvider and config.rootPath (relative-path base)
 *
 * Result envelope (from the last stage) carries: fileId, chunkIds,
 * tagIds, removedChunkIds, vectorIndexWritten, ... plus the file
 * snapshot produced by FileReaderStage.
 */
class IngestPipeline extends Pipeline {
  config: MemoryConfigOverrides;
  /**
   * @param {object} [config={}] - pipeline-level config (forwarded to ctx.config)
   * @param {object} [options={}]
   * @param {import('../core/stage').Stage[]} [options.stages] - explicit chain override
   */
  constructor(config: MemoryConfigOverrides = {}, options: PipelineOptions = {}) {
    const stages = Array.isArray(options.stages)
      ? options.stages
      : IngestPipeline.defaultStages(config);
    super(stages);
    this.name = 'ingestPipeline';
    this.config = config || {};
  }

  /**
   * The default ingestion chain, in _flushBatch execution order.
   * @param {object} config - stage gates (none today; kept for future knobs)
   * @returns {import('../core/stage').Stage[]}
   */
  static defaultStages(_config: MemoryConfigOverrides): Stage[] {
    return [
      new FileReaderStage(),
      new TagExtractorStage(),
      new ChunkerStage(),
      new ChunkEmbedderStage(),
      new TagEmbedderStage(),
      new MetadataWriterStage(),
      new VectorIndexerStage(),
      new CooccurrenceBuilderStage()
    ];
  }
}

export = IngestPipeline;
