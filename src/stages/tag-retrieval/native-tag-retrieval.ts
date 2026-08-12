"use strict";

import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";
import type { TagGraphPropagationData } from "../../types/retrieval.js";
import type {
  TagBasisProjectionEnvelope,
  TagResidualDecompositionData,
} from "../../types/retrieval.js";
import Stage from "../../core/stage.js";
import {
  getTagRetrievalIndex,
  nativeDatabasePath,
  readRecord,
  readNumberList,
  runTagRetrievalPipeline,
  toTagGraphPropagation,
} from "../../native/tag-graph-artifact-runtime.js";
import type { NativeArtifactState } from "../../native/tag-graph-artifact-runtime.js";
import { mergeTagRetrievalObservation } from "./tag-retrieval-observation.js";

/**
 * Executes the single native tag-retrieval pipeline. Artifact preparation is
 * an engine-level derived-maintenance concern; this stage is a read-only
 * consumer and falls back when no valid prebuilt artifact was supplied.
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

    if (!nativeDatabasePath(ctx)) {
      return {
        ...info,
        tagRetrievalSkipped: true,
        tagRetrievalSkipReason:
          "TagRetrievalRuntime requires a file-backed SQLite database",
        tagRetrievalFailure: "backend_unavailable",
        tagRetrievalError: "backend_unavailable",
      };
    }

    const suppliedArtifact = info.tagGraphArtifact as
      Partial<NativeArtifactState> | undefined;
    const prebuiltArtifact =
      suppliedArtifact &&
      typeof suppliedArtifact.dbPath === "string" &&
      suppliedArtifact.dbPath === nativeDatabasePath(ctx) &&
      typeof suppliedArtifact.artifactSig === "string" &&
      suppliedArtifact.artifactSig.length > 0
        ? (suppliedArtifact as NativeArtifactState)
        : null;
    if (!prebuiltArtifact) {
      return {
        ...info,
        tagRetrievalSkipped: true,
        tagRetrievalSkipReason: "prebuilt native tag-retrieval artifact unavailable",
        tagRetrievalFailure: "artifact_unavailable",
        tagRetrievalError: "artifact_unavailable",
      };
    }

    const result = await runTagRetrievalPipeline(ctx, index, prebuiltArtifact, info);
    if (!result.value) {
      return {
        ...info,
        tagGraphArtifact: prebuiltArtifact,
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
    const basis = result.value.tagBasisProjection as
      TagBasisProjectionEnvelope | undefined;
    const residual = result.value.tagResidualDecomposition as
      TagResidualDecompositionData | undefined;
    const nativeObservation = readRecord(result.value.observation);
    const tagRetrievalObservation = mergeTagRetrievalObservation(info, {
      source: "native",
      basis,
      residual,
      propagation: tagGraphPropagation,
      enhancedVector: hasEnhancedVector ? new Float32Array(enhanced) : undefined,
      localVector: readNumberList(result.value.localVector),
      extendedVector: readNumberList(result.value.extendedVector),
      localDistribution: result.value.localDistribution as
        ReadonlyArray<readonly [number, number]> | undefined,
      extendedDistribution: result.value.extendedDistribution as
        ReadonlyArray<readonly [number, number]> | undefined,
      localSupportIds: readNumberList(result.value.localSupportIds),
      extendedSupportIds: readNumberList(result.value.extendedSupportIds),
      observationHandle:
        typeof result.value.observationHandle === "string"
          ? result.value.observationHandle
          : undefined,
      nativeObservation,
      diagnostics: readRecord(result.value.diagnostics),
    });

    return {
      ...info,
      tagRetrieval: result.value,
      tagRetrievalObservation,
      tagGraphArtifact: prebuiltArtifact,
      nativeQueryVector: info.queryVector,
      tagRetrievalSkipped: false,
      ...(basis ? { tagBasisProjection: basis } : {}),
      ...(residual ? { tagResidualDecomposition: residual } : {}),
      ...(hasEnhancedVector
        ? { queryVector: new Float32Array(enhanced), queries }
        : {}),
      ...(tagGraphPropagation ? { tagGraphPropagation } : {}),
    };
  }
}

export default NativeTagRetrievalStage;
