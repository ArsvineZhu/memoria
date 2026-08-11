"use strict";

import type {
  ChunkCandidate,
  PipelineContextLike,
  PipelineData,
  RiverMemoData,
} from "../../types.js";
import Stage from "../../core/stage.js";
import { createMemoRuntimeFacade } from "../../native/memo-runtime.js";
import {
  ensureNativeMemoArtifact,
  getNativeMemoIndex,
  nativeDatabasePath,
  readField,
  readNumberList,
  readRecord,
  type NativeArtifactState,
} from "./native-memo-runtime.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function vector(value: unknown, fallback: number[]): number[] {
  if (Array.isArray(value) || value instanceof Float32Array) {
    return Array.from(value as ArrayLike<number>, (item) => number(item));
  }
  return [...fallback];
}

function nativeValue(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function queryState(info: PipelineData): Record<string, unknown> {
  const nativeMemo = readRecord(info.nativeMemo);
  const observation = readRecord(nativeMemo.observation);
  const tagMemo = info.tagMemo;
  const activations: Array<[number, number]> = [];
  if (tagMemo?.activations instanceof Map) {
    for (const [id, energy] of tagMemo.activations.entries()) {
      const numericId = Number(id);
      const numericEnergy = Number(energy);
      if (Number.isFinite(numericId) && Number.isFinite(numericEnergy)) {
        activations.push([numericId, numericEnergy]);
      }
    }
  }
  const sourceField =
    readField(nativeMemo.observation && observation.sourceField).length > 0
      ? readField(observation.sourceField)
      : readField(tagMemo?.sourceField).length > 0
        ? readField(tagMemo?.sourceField)
        : activations;
  const localField =
    readField(nativeMemo.localField).length > 0
      ? readField(nativeMemo.localField)
      : readField(tagMemo?.localField);
  const transferField =
    readField(nativeMemo.transferField).length > 0
      ? readField(nativeMemo.transferField)
      : readField(tagMemo?.transferField);

  const graph = readRecord(tagMemo?.riverGraph);
  const riverNodes = Array.isArray(observation.nodes)
    ? observation.nodes
    : Array.isArray(graph.nodes)
      ? graph.nodes
      : [];
  const riverEdges = Array.isArray(observation.edges)
    ? observation.edges
    : Array.isArray(graph.edges)
      ? graph.edges
      : [];
  const fieldProvenance = Array.isArray(observation.nodes)
    ? observation.nodes.map((node) => {
        const record = readRecord(node);
        return {
          id: number(record.id),
          hop: number(record.hop),
          sourceType: String(record.sourceType || "unknown"),
        };
      })
    : [];

  return {
    queryId: typeof nativeMemo.queryId === "string" ? nativeMemo.queryId : undefined,
    sourceField,
    localField,
    transferField,
    localDomainIds:
      readNumberList(nativeMemo.localDomainIds).length > 0
        ? readNumberList(nativeMemo.localDomainIds)
        : readNumberList(tagMemo?.localDomain?.ids),
    transferDomainIds:
      readNumberList(nativeMemo.transferDomainIds).length > 0
        ? readNumberList(nativeMemo.transferDomainIds)
        : readNumberList(tagMemo?.transferDomain?.ids),
    riverNodes,
    riverEdges,
    fieldProvenance,
    completeObservation: sourceField.length > 0,
  };
}

function nativeTopologyConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const configured = config.nativeTopologyConfig;
  if (isRecord(configured)) return { ...configured };
  return {
    queryK: number(config.topologyQueryK, 100),
    denoisedK: number(config.topologyDenoisedK, 100),
    localFieldK: number(config.topologyLocalFieldK, 100),
    transferFieldK: number(config.topologyTransferFieldK, 100),
    bm25K: number(config.topologyBm25K, 50),
    anchorK: number(config.topologyAnchorK, 50),
    maxUnionCandidates: number(config.topologyMaxUnionCandidates, 300),
    localWeight: number(config.topologyLocalWeight, 0.6),
    transferWeight: number(config.topologyTransferWeight, 0.4),
    directionFloor: number(config.topologyDirectionFloor, 0.05),
    closureFloor: number(config.topologyClosureFloor, 0),
    semanticNodeThreshold: number(config.semanticNodeThreshold, 0.48),
    relativeDistanceTemperature: number(config.relativeDistanceTemperature, 0.35),
    reverseDirectionCredit: number(config.reverseDirectionCredit, 0.25),
    minimumRiverEdgeFlow: number(config.minimumRiverEdgeFlow, 0.015),
    maximumRiverEdges: number(config.maximumRiverEdges, 96),
    nodeOnlyReliabilityCap: number(config.nodeOnlyReliabilityCap, 0.2),
    kappaEdge: number(config.kappaEdge, 0.5),
    kappaRatio: number(config.kappaRatio, 0.3),
    omegaEpsilon: number(config.omegaEpsilon, 0.02),
    collapsedThreshold: number(config.collapsedThreshold, 0.12),
    sparseThreshold: number(config.sparseThreshold, 0.45),
    semanticAnchorThreshold: number(config.semanticAnchorThreshold, 0.8),
    semanticAnchorDiscount: number(config.semanticAnchorDiscount, 0.7),
    specificityFloor: number(config.specificityFloor, 0.35),
    rarityFloor: number(config.rarityFloor, 0.15),
    reliabilitySeedSaturation: number(config.reliabilitySeedSaturation, 2),
    fallbackReliabilityCap: number(config.fallbackReliabilityCap, 0.5),
    pureQueryWeight: number(config.pureQueryWeight, 0.25),
    pureLocalWeight: number(config.pureLocalWeight, 0.2),
    pureTransferWeight: number(config.pureTransferWeight, 0.15),
    topologyBonusCap: number(config.topologyBonusCap, 0.08),
    topologyPathSaturation: number(config.topologyPathSaturation, 0.15),
    conditionalBandwidth: number(config.conditionalBandwidth, 0.04),
    conditionalClosureBandwidth: number(config.conditionalClosureBandwidth, 0.1),
    conditionalDirectBandwidth: number(config.conditionalDirectBandwidth, 0.12),
    minimumPeers: number(config.minimumPeers, 3),
    minimumEffectivePeers: number(config.minimumEffectivePeers, 2.5),
    innovationConfidenceZ: number(config.innovationConfidenceZ, 1),
    innovationScale: number(config.innovationScale, 0.5),
    omegaGamma: number(config.omegaGamma, 1),
    structRoleMinOmega: number(config.structRoleMinOmega, 0.12),
    anchorBonusCap: number(config.anchorBonusCap, 0.1),
    anchorActivationZ: number(config.anchorActivationZ, 2),
    anchorActivationFloor: number(config.anchorActivationFloor, 0.05),
    anchorSaturation: number(config.anchorSaturation, 0.2),
    anchorFrontierContrast: number(config.anchorFrontierContrast, 2),
    anchorFrontierAbsFloor: number(config.anchorFrontierAbsFloor, 0.1),
  };
}

async function allowedFileIds(
  candidates: readonly ChunkCandidate[],
  ctx: PipelineContextLike,
): Promise<number[]> {
  const getFile = ctx.metadataStore?.getFileByChunkId;
  if (typeof getFile !== "function") return [];
  const ids = new Set<number>();
  for (const candidate of candidates) {
    const chunkId = Number(candidate.chunkId);
    if (!Number.isFinite(chunkId)) continue;
    try {
      const file = await getFile.call(ctx.metadataStore, chunkId);
      const id = Number(file?.id);
      if (Number.isFinite(id)) ids.add(id);
    } catch (_) {
      // Native projection is optional. A failed auxiliary lookup must not
      // invalidate already materialised candidates.
    }
  }
  return [...ids].sort((left, right) => left - right);
}

function candidateInput(candidate: ChunkCandidate): Record<string, unknown> {
  const score = number(candidate.score);
  return {
    id: Number(candidate.chunkId),
    score,
    hybridScore: score,
    vectorScore: number(candidate.vectorScore),
    bm25Score: number(candidate.bm25Score),
    anchorScore: number(candidate.anchorScore),
  };
}

function nativeCandidate(
  result: Record<string, unknown>,
  original: ChunkCandidate | undefined,
): ChunkCandidate | null {
  const chunkId = number(result.chunkId ?? result.id, NaN);
  if (!Number.isFinite(chunkId)) return null;
  const base = original ? { ...original } : { chunkId, score: 0 };
  const score = number(result.score, number(base.score));
  return {
    ...base,
    chunkId,
    score,
    topologyBonus: number(result.topologyBonus),
    anchorBonus: number(result.anchorBonus),
    topologyRole: result.role,
    riverRegime: result.riverRegime,
    omega: number(result.omega),
    nativeCandidateSources: result.candidateSources,
    nativeTopologyV3: result.topologyV3,
    nativeRelativeTopology: result.relativeTopology,
    nativeGeometry: result.geometry,
    nativeObservables: result.observables,
  };
}

class TopologyV3Stage extends Stage {
  constructor() {
    super();
    this.name = "topologyV3";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<PipelineData> {
    const info = input || {};
    const candidates = Array.isArray(info.mergedCandidates)
      ? (info.mergedCandidates as ChunkCandidate[])
      : [];
    if (candidates.length === 0 || ctx.config.topologyV3Enabled !== true) {
      return { ...info, topologyV3Skipped: true };
    }

    const index = getNativeMemoIndex(ctx);
    const dbPath = nativeDatabasePath(ctx);
    if (!index || !dbPath || typeof index.rerankRivermemoTopologyV3 !== "function") {
      return {
        ...info,
        topologyV3Skipped: true,
        topologyV3SkipReason: !dbPath
          ? "native Topology V3 requires a file-backed SQLite database"
          : "native Topology V3 index is unavailable",
      };
    }

    let artifact: NativeArtifactState | null = null;
    const cachedArtifact = isRecord(info.nativeMemoArtifact)
      ? info.nativeMemoArtifact
      : null;
    if (cachedArtifact && typeof cachedArtifact.artifactSig === "string") {
      artifact = cachedArtifact as unknown as NativeArtifactState;
    } else {
      const built = await ensureNativeMemoArtifact(ctx, index);
      artifact = built.state;
      if (!artifact) {
        return {
          ...info,
          topologyV3Skipped: true,
          topologyV3SkipReason:
            "reason" in built ? built.reason : "native artifact unavailable",
          topologyV3Error: "error" in built ? built.error : undefined,
        };
      }
    }

    // Vector/BM25 retrieval may use the Memo-enhanced vector, while Topology
    // still needs the original query vector as the semantic baseline.
    const query = vector(info.nativeQueryVector, vector(info.queryVector, []));
    const dimension = number(ctx.config.dimension, query.length);
    if (query.length !== dimension || dimension <= 0) {
      return {
        ...info,
        topologyV3Skipped: true,
        topologyV3SkipReason: "query vector dimension is not native-compatible",
      };
    }

    const nativeMemo = readRecord(info.nativeMemo);
    const enhanced = vector(nativeMemo.enhancedVector, query);
    const local = vector(nativeMemo.localVector, query);
    const transfer = vector(nativeMemo.transferVector, query);
    const options = isRecord(info.options) ? info.options : {};
    const originalById = new Map(
      candidates.map((candidate) => [candidate.chunkId, candidate]),
    );
    try {
      const runtime = createMemoRuntimeFacade(index, dbPath);
      const raw = await runtime.rerankTopologyV3(
        JSON.stringify({
          observationHandle:
            typeof nativeMemo.observationHandle === "string"
              ? nativeMemo.observationHandle
              : undefined,
          dimension,
          topK: Number(options.topK ?? ctx.config.topK ?? candidates.length),
          includeTrace: ctx.config.includeTopologyTrace !== false,
          query: {
            text: typeof info.query === "string" ? info.query : "",
            vector: query,
          },
          denoisedVector: enhanced,
          localVector: local,
          transferVector: transfer,
          candidates: candidates.map(candidateInput),
          queryState: queryState(info),
          allowedFileIds: await allowedFileIds(candidates, ctx),
          config: nativeTopologyConfig(ctx.config),
        }),
        artifact.artifactSig,
      );
      const output = nativeValue(raw);
      const nativeResults =
        output && Array.isArray(output.results) ? output.results : null;
      if (!output || !nativeResults) {
        return {
          ...info,
          topologyV3Skipped: true,
          topologyV3SkipReason: "native Topology V3 returned invalid JSON",
        };
      }
      const ranked = nativeResults
        .map((result) =>
          nativeCandidate(
            readRecord(result),
            originalById.get(
              number(readRecord(result).chunkId ?? readRecord(result).id, NaN),
            ),
          ),
        )
        .filter((candidate): candidate is ChunkCandidate => candidate !== null);
      const rankedIds = new Set(ranked.map((candidate) => candidate.chunkId));
      // Native projection can legitimately omit a candidate whose SQLite
      // vector is malformed or stale. Keep that candidate at its previous
      // score so enabling Topology V3 never turns a partial native read into
      // data loss.
      for (const candidate of candidates) {
        if (!rankedIds.has(candidate.chunkId)) ranked.push(candidate);
      }
      const river = readRecord(output.omega);
      const diagnostics = readRecord(output.diagnostics);
      const riverMemo: RiverMemoData = {
        ...(isRecord(info.riverMemo) ? info.riverMemo : {}),
        version: "v3",
        algorithmVersion: output.algorithmVersion,
        native: true,
        omega: number(river.omega),
        regime: typeof river.regime === "string" ? river.regime : undefined,
        diagnostics,
        artifactSig: output.artifactSig,
        rerankedCount: ranked.length,
      };
      return {
        ...info,
        mergedCandidates: ranked,
        riverMemo,
        topologyV3: output,
        topologyV3Skipped: false,
      };
    } catch (error) {
      return {
        ...info,
        topologyV3Skipped: true,
        topologyV3SkipReason: "native Topology V3 failed",
        topologyV3Error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export default TopologyV3Stage;
