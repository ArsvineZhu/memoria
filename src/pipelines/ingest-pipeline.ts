"use strict";

import Pipeline from "../core/pipeline.js";
import FileReaderStage from "../stages/ingestion/file-reader.js";
import TagExtractorStage from "../stages/ingestion/tag-extractor.js";
import ChunkerStage from "../stages/ingestion/text-chunker.js";
import ChunkEmbedderStage from "../stages/ingestion/chunk-embedder.js";
import TagEmbedderStage from "../stages/ingestion/tag-embedder.js";
import RelationExtractorStage from "../stages/ingestion/relation-extractor.js";
import MetadataWriterStage from "../stages/ingestion/metadata-writer.js";
import VectorIndexerStage from "../stages/ingestion/vector-indexer.js";
import CooccurrenceBuilderStage from "../stages/ingestion/co-occurrence-builder.js";
import type { MemoryConfigOverrides } from "../types.js";
import Stage from "../core/stage.js";

interface PipelineOptions {
  stages?: Stage[];
}

/**
 * IngestPipeline — one-file ingestion chain.
 *
 * Handles the MemoryEngine ingestion flow for a single file:
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
   * @param {import('../core/stage.js').Stage[]} [options.stages] - explicit chain override
   */
  constructor(config: MemoryConfigOverrides = {}, options: PipelineOptions = {}) {
    const stages = Array.isArray(options.stages)
      ? options.stages
      : IngestPipeline.defaultStages(config);
    super(stages);
    this.name = "ingestPipeline";
    this.config = config || {};
  }

  /**
   * The default ingestion chain, in _flushBatch execution order.
   * @param {object} config - stage gates (none today; kept for future knobs)
   * @returns {import('../core/stage.js').Stage[]}
   */
  static defaultStages(_config: MemoryConfigOverrides): Stage[] {
    const stages: Stage[] = [
      new FileReaderStage(),
      new TagExtractorStage(),
      new ChunkerStage(),
      new ChunkEmbedderStage(),
      new TagEmbedderStage(),
      ...(_config.relationGraphEnabled !== false ? [new RelationExtractorStage()] : []),
      new MetadataWriterStage(),
      new VectorIndexerStage(),
      new CooccurrenceBuilderStage(),
    ];
    return stages;
  }
}

export default IngestPipeline;
