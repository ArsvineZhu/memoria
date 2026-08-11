"use strict";

import type {
  MemoryConfigOverrides,
  PipelineContextLike,
  PipelineData,
  UnknownRecord,
} from "../../types.js";
import Stage from "../../core/stage.js";
import {
  createMemoRuntimeFacade,
  type MemoRuntimeIndex,
} from "../../native/memo-runtime.js";

interface NativeMemoIndex extends UnknownRecord, MemoRuntimeIndex {}

export interface NativeArtifactState {
  dbPath: string;
  artifactSig: string;
  generation: number | null;
  databaseGeneration?: string;
  nodeCount?: number;
  edgeCount?: number;
}

interface ArtifactCacheEntry {
  generationKey: string;
  configKey: string;
  state: NativeArtifactState;
}

export type NativeMemoFailure =
  "artifact_build_failed" | "backend_unavailable" | "invalid_result";

const artifactCache = new WeakMap<object, Map<string, ArtifactCacheEntry>>();

/** Clear the JS artifact handle and the bound native runtime for one index. */
export function clearNativeMemoArtifactCache(index: object): void {
  artifactCache.delete(index);
  const runtimeIndex = index as MemoRuntimeIndex;
  if (typeof runtimeIndex.clearMemoRuntime === "function") {
    runtimeIndex.clearMemoRuntime.call(runtimeIndex);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function asNativeMemoIndex(value: unknown): NativeMemoIndex | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.rebuildMemoArtifact !== "function" &&
    typeof value.runMemoPipeline !== "function" &&
    typeof value.rerankRivermemoTopologyV3 !== "function"
  ) {
    return null;
  }
  return value as NativeMemoIndex;
}

export function getNativeMemoIndex(
  ctx: PipelineContextLike,
  indexName = String(ctx.config.tagIndexName || "global_tags"),
): NativeMemoIndex | null {
  const explicit = asNativeMemoIndex(ctx.vexusIndex);
  if (explicit) return explicit;

  const vectorStore = ctx.vectorStore as { indices?: unknown } | null | undefined;
  if (vectorStore?.indices instanceof Map) {
    return asNativeMemoIndex(vectorStore.indices.get(indexName));
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

function cloneRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? { ...value } : {};
}

/**
 * Select only serialisable native artifact knobs from the public config.
 * Functions and provider instances must never cross the N-API boundary.
 */
export function buildNativeArtifactConfig(
  config: MemoryConfigOverrides,
): UnknownRecord {
  const configured = config.nativeMemoArtifactConfig;
  if (isRecord(configured)) return cloneRecord(configured);

  return {
    v9: {
      outboundMass: number(config.outboundMass, 0.95),
      associationReserveMass: number(config.associationReserveMass, 0.05),
      evidenceCompression: number(config.evidenceCompression, 1),
      wormholeGain: number(config.wormholeGain, 1.35),
      tensionThreshold: number(config.tensionThreshold, 1),
      hubPenaltyExponent: number(config.hubPenaltyExponent, 0.3),
      hubPenaltyFloor: number(config.hubPenaltyFloor, 0.55),
      hubPenaltyCeiling: number(config.hubPenaltyCeiling, 1.8),
      hubSmoothingRatio: number(config.hubSmoothingRatio, 0.1),
    },
    orderedCooccurrence: {
      forwardGain: number(config.forwardGain, 1),
      reverseGain: number(config.reverseGain, 0.42),
      minReverseGain: number(config.minReverseGain, 0.25),
      maxReverseGain: number(config.maxReverseGain, 0.7),
      distanceDecay: number(config.distanceDecay, 0),
      reverseInversionGuard: number(config.reverseInversionGuard, 0.95),
      reverseAnchorBoost: boolean(config.reverseAnchorBoost, false),
      reverseAnchorMax: number(config.reverseAnchorMax, 1.5),
    },
    semanticGain: {
      enabled: boolean(config.semanticGainEnabled, false),
      peak: number(config.semanticGainPeak, 0.65),
      sigma: number(config.semanticGainSigma, 0.25),
      lowSimFallback: number(config.semanticGainLowSimFallback, 0.1),
    },
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!isRecord(item) || Array.isArray(item)) return item;
    return Object.keys(item)
      .sort()
      .reduce<Record<string, unknown>>((out, key) => {
        out[key] = item[key];
        return out;
      }, {});
  });
}

async function metadataGeneration(ctx: PipelineContextLike): Promise<string> {
  if (typeof ctx.metadataStore?.getKv !== "function") return "unknown";
  try {
    const [metadata, relations] = await Promise.all([
      ctx.metadataStore.getKv("memoria.metadata_generation"),
      typeof ctx.metadataStore.getRelationGeneration === "function"
        ? ctx.metadataStore.getRelationGeneration()
        : ctx.metadataStore.getKv("memoria.relation_generation"),
    ]);
    const metadataValue =
      typeof metadata === "string" ? metadata : stableJson(metadata);
    const relationValue =
      typeof relations === "string" || typeof relations === "number"
        ? String(relations)
        : stableJson(relations);
    return `${metadataValue}|relations:${relationValue}`;
  } catch {
    return "unavailable";
  }
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

export async function ensureNativeMemoArtifact(
  ctx: PipelineContextLike,
  index: NativeMemoIndex,
): Promise<
  | { state: NativeArtifactState }
  | { state: null; reason: string; failure: NativeMemoFailure }
> {
  const dbPath = nativeDatabasePath(ctx);
  if (!dbPath) {
    return {
      state: null,
      reason: "native MemoRuntime requires a file-backed SQLite database",
      failure: "backend_unavailable",
    };
  }
  let runtime;
  try {
    runtime = createMemoRuntimeFacade(index, dbPath);
  } catch {
    return {
      state: null,
      reason: "native index has no Memo artifact builder",
      failure: "backend_unavailable",
    };
  }

  const modelSig = String(ctx.config.modelSig || "memoria-default");
  const effectiveConfig = buildNativeArtifactConfig(ctx.config);
  const configKey = stableJson({ modelSig, effectiveConfig });
  const generationKey = await metadataGeneration(ctx);
  let entries = artifactCache.get(index);
  if (!entries) {
    entries = new Map();
    artifactCache.set(index, entries);
  }
  const cached = entries.get(dbPath);
  if (
    cached &&
    cached.generationKey === generationKey &&
    cached.configKey === configKey
  ) {
    return { state: cached.state };
  }

  try {
    const result = await runtime.rebuildArtifact(
      JSON.stringify({ modelSig, effectiveConfig }),
    );
    const artifactSig = result && String(result.artifactSig || "");
    if (!artifactSig) {
      return {
        state: null,
        reason: "native Memo artifact builder returned no artifact signature",
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
    entries.set(dbPath, { generationKey, configKey, state });
    return { state };
  } catch {
    return {
      state: null,
      reason: "native Memo artifact build failed",
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
    baseTagBoost: number(config.baseTagBoost, 0.6),
    coreBoostFactor: number(config.coreBoostFactor, 1.33),
    localAlpha: number(config.localAlpha, 0.15),
    transferAlpha: number(config.transferAlpha, 0.55),
    fieldMaxIterations: number(
      config.localMaxIterations ?? config.solverMaxIterations,
      80,
    ),
    localTolerance: number(config.localTolerance ?? config.solverTolerance, 1e-9),
    transferTolerance: number(config.transferTolerance ?? config.solverTolerance, 1e-9),
    localMassRatio: number(config.localMassRatio, 0.8),
    transferMassRatio: number(config.transferMassRatio, 0.9),
    maxLevels: number(config.pyramidMaxLevels, 3),
    pyramidTopK: number(config.pyramidTopK, 10),
    minEnergyRatio: number(config.minEnergyRatio, 0.1),
    layerDecay: number(config.layerDecay, 0.7),
    activationMultiplier: Array.isArray(config.activationMultiplier)
      ? config.activationMultiplier
      : [0.5, 1.5],
    dynamicBoostRange: Array.isArray(config.dynamicBoostRange)
      ? config.dynamicBoostRange
      : [0.3, 2],
    coreBoostRange: Array.isArray(config.coreBoostRange)
      ? config.coreBoostRange
      : [1.2, 1.4],
    langConfidenceEnabled: boolean(config.langConfidenceEnabled, true),
    langPenaltyUnknown: number(config.langPenaltyUnknown, 0.05),
    langPenaltyCrossDomain: number(config.langPenaltyCrossDomain, 0.2),
    deduplicationThreshold: number(config.deduplicationThreshold, 0.88),
    maxFusionTags: number(config.maxFusionTags, 128),
    maxEmergentNodes: number(config.maxEmergentNodes, 50),
    techTagThreshold: number(config.techTagThreshold, 0.08),
    normalTagThreshold: number(config.normalTagThreshold, 0.015),
    spikeRouting: {
      maxSafeHops: number(config.topologyMaxHops, 4),
      baseMomentum: number(config.baseMomentum, 2),
      firingThreshold: number(config.firingThreshold, 0.1),
      baseDecay: number(config.baseDecay, 0.25),
      wormholeDecay: number(config.wormholeDecay, 0.7),
      tensionThreshold: number(config.tensionThreshold, 1),
      maxNeighborsPerNode: number(config.maxNeighborsPerNode, 20),
      returnFlowFactor: number(config.v91ReturnFlowFactor, 0.15),
      firGamma: number(config.v91FirGamma, 0.6),
      maxPropagationStates: number(config.maxPropagationStates, 2000),
      minimumInjectedCurrent: number(config.minimumInjectedCurrent, 0.01),
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
  const pyramidTags = info.pyramid?.levels?.[0]?.tags || [];
  for (const tag of pyramidTags) {
    if (tag && tag.isCore === true && typeof tag.name === "string" && tag.name) {
      names.add(tag.name);
    }
  }
  const ranked = info.tagMemo?.ranked || [];
  for (const tag of ranked) {
    if (tag && tag.sourceType === "core" && typeof tag.name === "string" && tag.name) {
      names.add(tag.name);
    }
  }
  return [...names];
}

export async function runNativeMemoPipeline(
  ctx: PipelineContextLike,
  index: NativeMemoIndex,
  artifact: NativeArtifactState,
  info: PipelineData,
): Promise<
  { value: UnknownRecord } | { value: null; reason: string; failure: NativeMemoFailure }
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
    const runtime = createMemoRuntimeFacade(index, artifact.dbPath);
    const raw = await runtime.runPipeline(
      JSON.stringify({
        queryId: typeof info.queryId === "string" ? info.queryId : undefined,
        queryText: typeof info.query === "string" ? info.query : "",
        queryVector,
        coreTags: coreTagNames(info),
        ghostTags: [],
        config: nativePipelineConfig(ctx.config),
      }),
      artifact.artifactSig,
    );
    const value = parseNativeJson(raw);
    return value
      ? { value }
      : {
          value: null,
          reason: "native Memo pipeline returned invalid JSON",
          failure: "invalid_result",
        };
  } catch {
    return {
      value: null,
      reason: "native Memo pipeline failed",
      failure: "backend_unavailable",
    };
  }
}

export function readNumberList(value: unknown): number[] {
  return vectorArray(value);
}

export function readField(value: unknown): Array<[number, number]> {
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

function nativeTagMemo(
  info: PipelineData,
  config: MemoryConfigOverrides,
  value: UnknownRecord,
): UnknownRecord | undefined {
  if (config.tagMemoV9Enabled !== true && config.tagMemoV10Enabled !== true) {
    return undefined;
  }
  const observation = readRecord(value.observation);
  const sourceField = readField(observation.sourceField);
  const localField = readField(value.localField);
  const transferField = readField(value.transferField);
  const activations = new Map<number, number>(sourceField);
  const nodes = Array.isArray(observation.nodes) ? observation.nodes : [];
  const edges = Array.isArray(observation.edges) ? observation.edges : [];
  return {
    ...(isRecord(info.tagMemo) ? info.tagMemo : {}),
    version: config.tagMemoV10Enabled === true ? "v10" : "v9",
    nativeBackend: "rust-shared-memo-runtime",
    activations,
    sourceField,
    localField,
    transferField,
    localDomain: {
      ids: readNumberList(value.localDomainIds),
      mass: localField.reduce((sum, entry) => sum + entry[1], 0),
    },
    transferDomain: {
      ids: readNumberList(value.transferDomainIds),
      mass: transferField.reduce((sum, entry) => sum + entry[1], 0),
    },
    ranked: sourceField.map(([id, energy]) => ({ id, energy })),
    riverGraph: {
      nodes,
      edges,
      diagnostics: readRecord(observation.diagnostics),
    },
    nativeObservation: observation,
  };
}

/** Runs the Rust EPA/Pyramid/Spike pipeline and stores its observation handle. */
class NativeMemoRuntimeStage extends Stage {
  constructor() {
    super();
    this.name = "nativeMemoRuntime";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<PipelineData> {
    const info = input || {};
    const index = getNativeMemoIndex(ctx);
    if (!index) {
      return {
        ...info,
        nativeMemoSkipped: true,
        nativeMemoSkipReason: "native index unavailable",
        nativeMemoFailure: "backend_unavailable",
        nativeMemoError: "backend_unavailable",
      };
    }
    const artifact = await ensureNativeMemoArtifact(ctx, index);
    if (!artifact.state) {
      return {
        ...info,
        nativeMemoSkipped: true,
        nativeMemoSkipReason: artifact.reason,
        nativeMemoFailure: artifact.failure,
        nativeMemoError: artifact.failure,
      };
    }
    const result = await runNativeMemoPipeline(ctx, index, artifact.state, info);
    if (!result.value) {
      return {
        ...info,
        nativeMemoSkipped: true,
        nativeMemoSkipReason: result.reason,
        nativeMemoFailure: result.failure,
        nativeMemoError: result.failure,
        nativeMemoArtifact: artifact.state,
      };
    }
    const enhanced = readNumberList(result.value.enhancedVector);
    const queryVector = readNumberList(info.queryVector);
    const hasEnhancedVector =
      enhanced.length > 0 && enhanced.length === queryVector.length;
    const queries = Array.isArray(info.queries)
      ? info.queries.map((query, position) =>
          position === 0 && hasEnhancedVector
            ? { ...query, vector: new Float32Array(enhanced) }
            : query,
        )
      : info.queries;
    const tagMemo = nativeTagMemo(info, ctx.config, result.value);
    return {
      ...info,
      nativeMemo: result.value,
      nativeMemoArtifact: artifact.state,
      nativeQueryVector: info.queryVector,
      nativeMemoSkipped: false,
      ...(hasEnhancedVector
        ? { queryVector: new Float32Array(enhanced), queries }
        : {}),
      ...(tagMemo ? { tagMemo } : {}),
    };
  }
}

export default NativeMemoRuntimeStage;
