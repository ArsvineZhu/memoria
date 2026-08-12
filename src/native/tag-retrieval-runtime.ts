"use strict";

import type { TagRetrievalArtifactBuildResult } from "../../rust-vexus-lite/index.js";

export interface TagRetrievalRuntimeStats {
  activeArtifactSig?: string;
  generation: number;
  nodeCount: number;
  edgeCount: number;
  resident: boolean;
}

export interface TagRetrievalRuntimeIndex {
  rebuildTagGraphArtifact?(dbPath: string, inputJson: string): Promise<unknown>;
  runTagRetrievalPipeline?(
    dbPath: string,
    artifactSig: string,
    inputJson: string,
  ): Promise<unknown>;
  runActivationPropagation?(
    dbPath: string,
    artifactSig: string,
    inputJson: string,
  ): Promise<unknown>;
  rerankByPropagationSupport?(
    dbPath: string,
    artifactSig: string,
    inputJson: string,
  ): Promise<unknown>;
  rerankByPropagationStructure?(
    dbPath: string,
    artifactSig: string,
    inputJson: string,
  ): Promise<unknown>;
  clearTagRetrievalRuntime?(): void;
  tagRetrievalRuntimeStats?(): TagRetrievalRuntimeStats;
  computeTagBasis?(
    dbPath: string,
    clusterCount: number,
    maxBasisDim: number,
  ): Promise<unknown>;
  publishTagBasisCache?(dbPath: string): unknown;
  computeTagResidualMetrics?(
    dbPath: string,
    maxRank?: number | null,
    minNeighbors?: number | null,
    modelSig?: string | null,
    effectiveConfigJson?: string | null,
  ): Promise<unknown>;
  computeTagPairSimilarities?(
    dbPath: string,
    modelSig: string,
    minSimilarity?: number | null,
    fullRebuild?: boolean | null,
  ): Promise<unknown>;
  projectTagBasis?(
    vector: Float32Array,
    flattenedBasis: Float32Array,
    meanVector: Float32Array,
    count: number,
  ): unknown;
  computeResidualDirections?(
    vector: Float32Array,
    flattenedTags: Float32Array,
    count: number,
  ): unknown;
  projectDiffusionDistributions?(
    tagIds: number[],
    localMasses: Float64Array,
    extendedMasses: Float64Array,
  ): unknown;
  fuseTagContext?(
    original: Float32Array,
    tagIds: number[],
    tagWeights: Float64Array,
    alpha: number,
    dedupThreshold?: number | null,
    maxTags?: number | null,
  ): unknown;
}

export interface TagRetrievalRuntimeFacade {
  readonly dbPath: string;
  rebuildTagGraphArtifact(inputJson: string): Promise<TagRetrievalArtifactBuildResult>;
  runTagRetrievalPipeline(inputJson: string, artifactSig: string): Promise<unknown>;
  runActivationPropagation(inputJson: string, artifactSig: string): Promise<unknown>;
  rerankByPropagationSupport(inputJson: string, artifactSig: string): Promise<unknown>;
  rerankByPropagationStructure(
    inputJson: string,
    artifactSig: string,
  ): Promise<unknown>;
  clearTagRetrievalRuntime(): void;
  tagRetrievalRuntimeStats(): TagRetrievalRuntimeStats;
}

const EMPTY_STATS: TagRetrievalRuntimeStats = {
  generation: 0,
  nodeCount: 0,
  edgeCount: 0,
  resident: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function artifactSignature(value: string): string {
  const normalized = String(value || "").trim();
  if (!normalized)
    throw new TypeError(
      "A non-empty tag association graph artifact signature is required.",
    );
  return normalized;
}

function assertDbPath(value: string): string {
  const normalized = String(value || "").trim();
  if (
    !normalized ||
    normalized === ":memory:" ||
    normalized.startsWith("file::memory:")
  ) {
    throw new TypeError(
      "TagRetrievalRuntime requires a file-backed SQLite database path.",
    );
  }
  return normalized;
}

function assertMethod<K extends keyof TagRetrievalRuntimeIndex>(
  index: TagRetrievalRuntimeIndex,
  method: K,
): NonNullable<TagRetrievalRuntimeIndex[K]> {
  const implementation = index[method];
  if (typeof implementation !== "function") {
    throw new Error(`Native tag-retrieval index does not expose ${String(method)}().`);
  }
  return implementation as NonNullable<TagRetrievalRuntimeIndex[K]>;
}

export function createTagRetrievalRuntimeFacade(
  index: TagRetrievalRuntimeIndex,
  dbPath: string,
): TagRetrievalRuntimeFacade {
  if (!isRecord(index))
    throw new TypeError("A native tag-retrieval index is required.");
  const boundDbPath = assertDbPath(dbPath);
  const invoke = (method: keyof TagRetrievalRuntimeIndex, ...args: unknown[]) => {
    const implementation = assertMethod(index, method);
    return (implementation as (...values: unknown[]) => unknown).call(
      index,
      boundDbPath,
      ...args,
    );
  };

  return {
    dbPath: boundDbPath,

    async rebuildTagGraphArtifact(inputJson) {
      const result = parseJsonRecord(
        await invoke("rebuildTagGraphArtifact", String(inputJson || "{}")),
      );
      const artifactSig =
        typeof result?.artifactSig === "string" ? result.artifactSig.trim() : "";
      if (!artifactSig)
        throw new Error(
          "TagRetrievalRuntime artifact builder returned no artifact signature.",
        );
      return result as unknown as TagRetrievalArtifactBuildResult;
    },

    runTagRetrievalPipeline(inputJson, artifactSig) {
      return invoke(
        "runTagRetrievalPipeline",
        artifactSignature(artifactSig),
        String(inputJson || "{}"),
      ) as Promise<unknown>;
    },

    runActivationPropagation(inputJson, artifactSig) {
      return invoke(
        "runActivationPropagation",
        artifactSignature(artifactSig),
        String(inputJson || "{}"),
      ) as Promise<unknown>;
    },

    rerankByPropagationSupport(inputJson, artifactSig) {
      return invoke(
        "rerankByPropagationSupport",
        artifactSignature(artifactSig),
        String(inputJson || "{}"),
      ) as Promise<unknown>;
    },

    rerankByPropagationStructure(inputJson, artifactSig) {
      return invoke(
        "rerankByPropagationStructure",
        artifactSignature(artifactSig),
        String(inputJson || "{}"),
      ) as Promise<unknown>;
    },

    clearTagRetrievalRuntime() {
      if (typeof index.clearTagRetrievalRuntime === "function") {
        index.clearTagRetrievalRuntime.call(index);
      }
    },

    tagRetrievalRuntimeStats() {
      if (typeof index.tagRetrievalRuntimeStats !== "function")
        return { ...EMPTY_STATS };
      const stats = index.tagRetrievalRuntimeStats.call(index);
      return isRecord(stats)
        ? ({ ...EMPTY_STATS, ...stats } as TagRetrievalRuntimeStats)
        : { ...EMPTY_STATS };
    },
  };
}

export default createTagRetrievalRuntimeFacade;
