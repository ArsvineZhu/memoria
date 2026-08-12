"use strict";

import type {
  PipelineContextLike,
  PipelineData,
  TagGraphPropagationData,
} from "../../types.js";
import Stage from "../../core/stage.js";
import {
  ensureTagRetrievalArtifact,
  getTagRetrievalIndex,
  readNumberList,
  runTagRetrievalPipeline,
  toTagGraphPropagation,
} from "../../native/tag-graph-artifact-runtime.js";

/**
 * Executes the single native tag-retrieval pipeline. The stage owns artifact
 * resolution and query-vector projection; candidate reranking remains in the
 * dedicated support and structure stages.
 */
class NativeTagRetrievalStage extends Stage {
  constructor() {
    super();
    this.name = "nativeTagRetrieval";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<PipelineData> {
    const info = input || {};
    if (ctx.config.nativeTagRetrievalEnabled !== true) {
      return { ...info, tagRetrievalSkipped: true };
    }

    const index = getTagRetrievalIndex(ctx);
    if (!index) {
      return {
        ...info,
        tagRetrievalSkipped: true,
        tagRetrievalSkipReason: "native tag-retrieval index unavailable",
        tagRetrievalFailure: "backend_unavailable",
        tagRetrievalError: "backend_unavailable",
      };
    }

    const artifact = await ensureTagRetrievalArtifact(ctx, index);
    if (!artifact.state) {
      return {
        ...info,
        tagRetrievalSkipped: true,
        tagRetrievalSkipReason: artifact.reason,
        tagRetrievalFailure: artifact.failure,
        tagRetrievalError: artifact.failure,
      };
    }

    const result = await runTagRetrievalPipeline(ctx, index, artifact.state, info);
    if (!result.value) {
      return {
        ...info,
        tagGraphArtifact: artifact.state,
        tagRetrievalSkipped: true,
        tagRetrievalSkipReason: result.reason,
        tagRetrievalFailure: result.failure,
        tagRetrievalError: result.failure,
      };
    }

    const queryVector = readNumberList(info.queryVector);
    const enhanced = readNumberList(result.value.enhancedVector);
    const hasEnhancedVector =
      enhanced.length > 0 && enhanced.length === queryVector.length;
    const queries = Array.isArray(info.queries)
      ? info.queries.map((query, position) =>
          position === 0 && hasEnhancedVector
            ? { ...query, vector: new Float32Array(enhanced) }
            : query,
        )
      : info.queries;
    const tagGraphPropagation = toTagGraphPropagation(
      info,
      ctx.config,
      result.value,
    ) as TagGraphPropagationData;

    return {
      ...info,
      tagRetrieval: result.value,
      tagGraphArtifact: artifact.state,
      nativeQueryVector: info.queryVector,
      tagRetrievalSkipped: false,
      ...(hasEnhancedVector
        ? { queryVector: new Float32Array(enhanced), queries }
        : {}),
      ...(tagGraphPropagation ? { tagGraphPropagation } : {}),
    };
  }
}

export default NativeTagRetrievalStage;
