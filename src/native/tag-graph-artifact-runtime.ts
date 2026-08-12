"use strict";

import type { MemoryConfigOverrides } from "../types/config.js";
import type { PipelineContextLike, PipelineData } from "../types/pipeline.js";
import type { UnknownRecord } from "../types/common.js";
import {
  buildNativeArtifactConfig,
  nativeDatabasePath,
  nativePipelineConfig,
} from "./tag-graph-runtime-config.js";
import { createRuntimeFacade } from "./tag-graph-runtime-index.js";
import {
  buildNativePipelinePayload,
  isRecord,
  parseNativeJson,
  readDistribution,
  readNumberList,
  readRecord,
  vectorArray,
} from "./tag-graph-runtime-serialization.js";
import type {
  NativeArtifactResult,
  NativeArtifactState,
  NativePipelineResult,
  TagRetrievalIndex,
} from "./tag-graph-runtime-types.js";

export type {
  NativeArtifactState,
  NativePipelineResult,
  TagRetrievalFailure,
} from "./tag-graph-runtime-types.js";
export {
  clearTagRetrievalRuntime,
  getTagRetrievalIndex,
} from "./tag-graph-runtime-index.js";
export {
  buildNativeArtifactConfig,
  nativeDatabasePath,
} from "./tag-graph-runtime-config.js";
export {
  readDistribution,
  readNumberList,
  readRecord,
} from "./tag-graph-runtime-serialization.js";

export async function ensureTagRetrievalArtifact(
  ctx: PipelineContextLike,
  index: TagRetrievalIndex,
): Promise<NativeArtifactResult> {
  const dbPath = nativeDatabasePath(ctx);
  if (!dbPath) {
    return {
      state: null,
      reason: "TagRetrievalRuntime requires a file-backed SQLite database",
      failure: "backend_unavailable",
    };
  }

  let runtime;
  try {
    runtime = createRuntimeFacade(index, dbPath);
  } catch {
    return {
      state: null,
      reason: "native index has no tag association graph artifact builder",
      failure: "backend_unavailable",
    };
  }

  try {
    const result = await runtime.rebuildTagGraphArtifact(
      JSON.stringify({
        modelSig: String(ctx.config.modelSig || "memoria-default"),
        effectiveConfig: buildNativeArtifactConfig(ctx.config),
      }),
    );
    const artifactSig = result && String(result.artifactSig || "");
    if (!artifactSig) {
      return {
        state: null,
        reason:
          "native tag association graph artifact builder returned no artifact signature",
        failure: "invalid_result",
      };
    }
    const state: NativeArtifactState = {
      dbPath,
      artifactSig,
      generation: typeof result.generation === "number" ? result.generation : null,
      databaseGeneration:
        typeof result.databaseGeneration === "string"
          ? result.databaseGeneration
          : undefined,
      nodeCount: typeof result.nodeCount === "number" ? result.nodeCount : undefined,
      edgeCount: typeof result.edgeCount === "number" ? result.edgeCount : undefined,
    };
    return { state };
  } catch {
    return {
      state: null,
      reason: "native tag association graph artifact build failed",
      failure: "artifact_build_failed",
    };
  }
}

export async function runTagRetrievalPipeline(
  ctx: PipelineContextLike,
  index: TagRetrievalIndex,
  artifact: NativeArtifactState,
  info: PipelineData,
): Promise<NativePipelineResult> {
  const payload = buildNativePipelinePayload(
    info,
    nativePipelineConfig(ctx.config),
    Number(ctx.config.dimension || 0),
  );
  if (!payload) {
    return {
      value: null,
      reason: `query vector dimension ${vectorArray(info.queryVector).length} does not match native dimension ${Number(ctx.config.dimension || 0)}`,
      failure: "invalid_result",
    };
  }

  try {
    const runtime = createRuntimeFacade(index, artifact.dbPath);
    const raw = await runtime.runTagRetrievalPipeline(
      JSON.stringify(payload),
      artifact.artifactSig,
    );
    const value = parseNativeJson(raw);
    return value
      ? { value }
      : {
          value: null,
          reason: "native tag retrieval pipeline returned invalid JSON",
          failure: "invalid_result",
        };
  } catch {
    return {
      value: null,
      reason: "native tag retrieval pipeline failed",
      failure: "backend_unavailable",
    };
  }
}

export function toTagGraphPropagation(
  info: PipelineData,
  config: MemoryConfigOverrides,
  value: UnknownRecord,
): UnknownRecord | undefined {
  if (config.tagGraphPropagationEnabled !== true) return undefined;

  const observation = readRecord(value.observation);
  const seedDistribution = readDistribution(observation.seedDistribution);
  const localDistribution = readDistribution(value.localDistribution);
  const extendedDistribution = readDistribution(value.extendedDistribution);
  const activations = new Map<number, number>(seedDistribution);
  const nodes = Array.isArray(observation.nodes) ? observation.nodes : [];
  const edges = Array.isArray(observation.edges) ? observation.edges : [];
  return {
    ...(isRecord(info.tagGraphPropagation) ? info.tagGraphPropagation : {}),
    schema: "tag-graph-propagation-v1",
    algorithmVersion: "tag-graph-activation-propagation",
    nativeBackend: "rust-shared-tag-retrieval-runtime",
    activations,
    seedDistribution,
    localDistribution,
    extendedDistribution,
    localSupport: {
      ids: readNumberList(value.localSupportIds),
      mass: localDistribution.reduce((sum, entry) => sum + entry[1], 0),
    },
    extendedSupport: {
      ids: readNumberList(value.extendedSupportIds),
      mass: extendedDistribution.reduce((sum, entry) => sum + entry[1], 0),
    },
    ranked: seedDistribution.map(([id, activation]) => ({ id, activation })),
    propagationTrace: {
      nodes,
      edges,
      diagnostics: readRecord(observation.diagnostics),
    },
    nativeObservation: observation,
  };
}
