"use strict";

import type {
  MemoryConfigOverrides,
  PipelineContextLike,
  PipelineData,
  UnknownRecord,
} from "../types.js";
import {
  createTagRetrievalRuntimeFacade,
  type TagRetrievalRuntimeIndex,
} from "./tag-retrieval-runtime.js";

interface TagRetrievalIndex extends UnknownRecord, TagRetrievalRuntimeIndex {}

export interface NativeArtifactState {
  dbPath: string;
  artifactSig: string;
  generation: number | null;
  databaseGeneration?: string;
  nodeCount?: number;
  edgeCount?: number;
}

export type TagRetrievalFailure =
  "artifact_build_failed" | "backend_unavailable" | "invalid_result";

/** Release the native runtime owned by one vector index. */
export function clearTagRetrievalRuntime(index: object): void {
  const runtimeIndex = index as TagRetrievalRuntimeIndex;
  if (typeof runtimeIndex.clearTagRetrievalRuntime === "function") {
    runtimeIndex.clearTagRetrievalRuntime.call(runtimeIndex);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function asTagRetrievalIndex(value: unknown): TagRetrievalIndex | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.rebuildTagGraphArtifact !== "function" &&
    typeof value.runTagRetrievalPipeline !== "function" &&
    typeof value.rerankByPropagationStructure !== "function"
  ) {
    return null;
  }
  return value as TagRetrievalIndex;
}

export function getTagRetrievalIndex(
  ctx: PipelineContextLike,
  indexName = String(ctx.config.tagVectorIndexName || "tag_vectors"),
): TagRetrievalIndex | null {
  const explicit = asTagRetrievalIndex(ctx.tagRetrievalRuntime);
  if (explicit) return explicit;

  const vectorStore = ctx.vectorStore as { indices?: unknown } | null | undefined;
  if (vectorStore?.indices instanceof Map) {
    return asTagRetrievalIndex(vectorStore.indices.get(indexName));
  }
  return null;
}

export function nativeDatabasePath(ctx: PipelineContextLike): string | null {
  const configured = ctx.config.dbPath;
  const storePath = (ctx.metadataStore as { dbPath?: unknown } | null | undefined)
    ?.dbPath;
  const value = configured ?? storePath;
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = value.trim();
  // rusqlite cannot share a JavaScript-only in-memory connection. A native
  // stage must fail closed here instead of silently creating another database.
  if (normalized === ":memory:" || normalized.startsWith("file::memory:")) {
    return null;
  }
  return normalized;
}

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Select only serialisable native artifact knobs from the public config.
 * Functions and provider instances must never cross the N-API boundary.
 */
export function buildNativeArtifactConfig(
  config: MemoryConfigOverrides,
): UnknownRecord {
  return {
    propagation: {
      propagationMaxHops: number(config.propagationMaxHops, 4),
      routingBudget: number(config.routingBudget, 20),
      activationThreshold: number(config.activationThreshold, 0.1),
      standardEdgePropagationFactor: number(config.standardEdgePropagationFactor, 0.25),
      shortcutEdgePropagationFactor: number(config.shortcutEdgePropagationFactor, 0.7),
      shortcutEdgeThreshold: number(config.shortcutEdgeThreshold, 1),
      shortcutEdgeGain: number(config.shortcutEdgeGain, 1.35),
      shortcutEdgeReserveMass: number(config.shortcutEdgeReserveMass, 0.05),
      maxNeighborsPerNode: number(config.maxNeighborsPerNode, 20),
      returnActivationFactor: number(config.returnActivationFactor, 0.15),
      hopReadoutGamma: number(config.hopReadoutGamma, 0.6),
      maxPropagationStates: number(config.maxPropagationStates, 2000),
      minimumInjectedActivation: number(config.minimumInjectedActivation, 0.0001),
    },
    diffusion: {
      localDiffusionAlpha: number(config.localDiffusionAlpha, 0.15),
      extendedDiffusionAlpha: number(config.extendedDiffusionAlpha, 0.55),
      diffusionMaxIterations: number(config.diffusionMaxIterations, 200),
      localDiffusionTolerance: number(config.localDiffusionTolerance, 1e-9),
      extendedDiffusionTolerance: number(config.extendedDiffusionTolerance, 1e-9),
      supportSelectionMethod: String(config.supportSelectionMethod || "mass_ratio"),
      localSupportMassRatio: number(config.localSupportMassRatio, 0.8),
      extendedSupportMassRatio: number(config.extendedSupportMassRatio, 0.9),
    },
  };
}

function parseNativeJson(value: unknown): UnknownRecord | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function ensureTagRetrievalArtifact(
  ctx: PipelineContextLike,
  index: TagRetrievalIndex,
): Promise<
  | { state: NativeArtifactState }
  | { state: null; reason: string; failure: TagRetrievalFailure }
> {
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
    runtime = createTagRetrievalRuntimeFacade(index, dbPath);
  } catch {
    return {
      state: null,
      reason: "native index has no tag association graph artifact builder",
      failure: "backend_unavailable",
    };
  }

  const modelSig = String(ctx.config.modelSig || "memoria-default");
  const effectiveConfig = buildNativeArtifactConfig(ctx.config);
  try {
    const result = await runtime.rebuildTagGraphArtifact(
      JSON.stringify({ modelSig, effectiveConfig }),
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

function vectorArray(value: unknown): number[] {
  if (!Array.isArray(value) && !(value instanceof Float32Array)) return [];
  return Array.from(value as ArrayLike<number>, (item) => number(item, 0));
}

function nativePipelineConfig(config: MemoryConfigOverrides): UnknownRecord {
  return {
    tagBasisClusterCount: number(config.tagBasisClusterCount, 64),
    tagBasisMaxDimensions: number(config.tagBasisMaxDimensions, 64),
    tagBasisPerCandidateAnalysis: boolean(config.tagBasisPerCandidateAnalysis, false),
    strictOrthogonalization: boolean(config.strictOrthogonalization, true),
    residualMaxSteps: number(config.residualMaxSteps, 3),
    residualTagTopK: number(config.residualTagTopK, 5),
    residualStopEnergyRatio: number(config.residualStopEnergyRatio, 0.1),
    localDiffusionAlpha: number(config.localDiffusionAlpha, 0.15),
    extendedDiffusionAlpha: number(config.extendedDiffusionAlpha, 0.55),
    diffusionMaxIterations: number(config.diffusionMaxIterations, 200),
    localDiffusionTolerance: number(config.localDiffusionTolerance, 1e-9),
    extendedDiffusionTolerance: number(config.extendedDiffusionTolerance, 1e-9),
    localSupportMassRatio: number(config.localSupportMassRatio, 0.8),
    extendedSupportMassRatio: number(config.extendedSupportMassRatio, 0.9),
    supportSelectionMethod: String(config.supportSelectionMethod || "mass_ratio"),
    activationPropagation: {
      propagationMaxHops: number(config.propagationMaxHops, 4),
      baseRoutingBudget: number(config.routingBudget, 20),
      activationThreshold: number(config.activationThreshold, 0.1),
      baseDecay: number(config.standardEdgePropagationFactor, 0.25),
      shortcutEdgeDecay: number(config.shortcutEdgePropagationFactor, 0.7),
      shortcutEdgeThreshold: number(config.shortcutEdgeThreshold, 1),
      maxNeighborsPerNode: number(config.maxNeighborsPerNode, 20),
      returnFlowFactor: number(config.returnActivationFactor, 0.15),
      firGamma: number(config.hopReadoutGamma, 0.6),
      maxPropagationStates: number(config.maxPropagationStates, 2000),
      minimumInjectedActivation: number(config.minimumInjectedActivation, 0.0001),
    },
  };
}

function coreTagNames(info: PipelineData): string[] {
  const names = new Set<string>();
  const explicit = Array.isArray(info.coreTags) ? info.coreTags : [];
  for (const tag of explicit) {
    const name = String(tag || "").trim();
    if (name) names.add(name);
  }
  const tagResidualDecompositionTags =
    info.tagResidualDecomposition?.levels?.[0]?.tags || [];
  for (const tag of tagResidualDecompositionTags) {
    if (tag && tag.isCore === true && typeof tag.name === "string" && tag.name) {
      names.add(tag.name);
    }
  }
  const ranked = info.tagGraphPropagation?.ranked || [];
  for (const tag of ranked) {
    if (tag && tag.sourceType === "core" && typeof tag.name === "string" && tag.name) {
      names.add(tag.name);
    }
  }
  return [...names];
}

export async function runTagRetrievalPipeline(
  ctx: PipelineContextLike,
  index: TagRetrievalIndex,
  artifact: NativeArtifactState,
  info: PipelineData,
): Promise<
  | { value: UnknownRecord }
  | { value: null; reason: string; failure: TagRetrievalFailure }
> {
  const dimension = number(ctx.config.dimension, 0);
  const queryVector = vectorArray(info.queryVector);
  if (dimension <= 0 || queryVector.length !== dimension) {
    return {
      value: null,
      reason: `query vector dimension ${queryVector.length} does not match native dimension ${dimension}`,
      failure: "invalid_result",
    };
  }

  try {
    const runtime = createTagRetrievalRuntimeFacade(index, artifact.dbPath);
    const raw = await runtime.runTagRetrievalPipeline(
      JSON.stringify({
        queryId: typeof info.queryId === "string" ? info.queryId : undefined,
        queryText: typeof info.query === "string" ? info.query : "",
        queryVector,
        coreTags: coreTagNames(info),
        supplementalTags: [],
        config: nativePipelineConfig(ctx.config),
      }),
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

export function readNumberList(value: unknown): number[] {
  return vectorArray(value);
}

export function readDistribution(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) return [];
      const id = Number(entry[0]);
      const mass = Number(entry[1]);
      return Number.isFinite(id) && Number.isFinite(mass)
        ? [[id, mass] as [number, number]]
        : [];
    })
    .sort((left, right) => right[1] - left[1] || left[0] - right[0]);
}

export function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function toTagGraphPropagation(
  info: PipelineData,
  config: MemoryConfigOverrides,
  value: UnknownRecord,
): UnknownRecord | undefined {
  if (config.tagGraphPropagationEnabled !== true) {
    return undefined;
  }
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
