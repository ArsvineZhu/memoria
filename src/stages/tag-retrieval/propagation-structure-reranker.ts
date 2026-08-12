import type {
  ChunkCandidate,
  MemoryConfigOverrides,
  PipelineContextLike,
  PipelineData,
  PropagationStructureData,
  PropagationTrace,
} from "../../types.js";

import Stage from "../../core/stage.js";
import { computePropagationSpread } from "../../algorithms/tag-graph/propagation-spread.js";
import { createTagRetrievalRuntimeFacade } from "../../native/tag-retrieval-runtime.js";
import {
  ensureTagRetrievalArtifact,
  getTagRetrievalIndex,
  nativeDatabasePath,
  readDistribution,
  readRecord,
} from "../../native/tag-graph-artifact-runtime.js";

const PROPAGATION_STRUCTURE_SCHEMA = "propagation-structure-v1";
type NativePropagationStructureFailure =
  "backend_unavailable" | "artifact_unavailable" | "invalid_result";

function numeric(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function currentNodeTotals(propagationTrace: PropagationTrace): Map<number, number> {
  const totals = new Map<number, number>();
  for (const edge of propagationTrace.edges || []) {
    const targetId = numeric(edge?.targetId, NaN);
    const flow = Math.max(0, numeric(edge?.flow));
    if (!Number.isFinite(targetId) || flow <= 0) continue;
    totals.set(targetId, (totals.get(targetId) || 0) + flow);
  }
  return totals;
}

function readNodeTotals(
  input: PipelineData,
  propagationTrace: PropagationTrace,
): Map<number, number> {
  const persisted = input.propagationHistory?.nodeTotals;
  if (persisted && typeof persisted === "object") {
    const totals = new Map<number, number>();
    for (const [key, value] of Object.entries(persisted)) {
      const id = numeric(key, NaN);
      const total = Math.max(0, numeric(value));
      if (Number.isFinite(id) && total > 0) totals.set(id, total);
    }
    return totals;
  }
  return currentNodeTotals(propagationTrace);
}

/** Rerank candidates using the current propagation spread and canonical history totals. */
class PropagationStructureRerankerStage extends Stage {
  constructor() {
    super();
    this.name = "propagationStructureReranker";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "propagationStructure" | "mergedCandidates"> & {
      propagationStructure?: PropagationStructureData;
      mergedCandidates?: ChunkCandidate[];
      propagationStructureSkipped?: boolean;
    }
  > {
    let info = input || {};
    if (ctx.config.propagationStructureRerankEnabled !== true) {
      return { ...info, propagationStructureSkipped: true };
    }

    if (
      ctx.config.nativeTagRetrievalEnabled === true &&
      info.tagRetrievalSkipped === false
    ) {
      const native = await this._nativeRerank(info, ctx);
      if (native.output) {
        return {
          ...native.output,
          mergedCandidates: (Array.isArray(native.output.mergedCandidates)
            ? native.output.mergedCandidates
            : info.mergedCandidates || []) as ChunkCandidate[],
        };
      }
      if (native.reason) {
        // Structural reranking is fail-closed: retain the TypeScript stage as
        // the deterministic local implementation when the native boundary is
        // unavailable or returns an invalid payload.
        info = {
          ...info,
          propagationStructureNativeSkipped: true,
          propagationStructureNativeSkipReason: native.reason,
          propagationStructureNativeFailure: native.failure,
        };
      }
    }

    const propagationTrace: PropagationTrace = info.tagGraphPropagation
      ?.propagationTrace || {
      nodes: [],
      edges: [],
      diagnostics: {},
    };
    const spread = computePropagationSpread({
      nodes: propagationTrace.nodes,
      edges: propagationTrace.edges,
      diagnostics: propagationTrace.diagnostics || {},
    });
    const nodeTotals = readNodeTotals(info, propagationTrace);
    const historySupport = Math.max(
      0,
      Math.min(1, numeric(info.propagationHistory?.historySupport, 0)),
    );
    const mergedCandidates = this._rerank(
      info.mergedCandidates,
      spread.spreadClass,
      nodeTotals,
      ctx.config,
    );

    return {
      ...info,
      propagationStructure: {
        schema: PROPAGATION_STRUCTURE_SCHEMA,
        spreadClass: spread.spreadClass,
        spreadScore: spread.spreadScore,
        historySupport,
        nodeTotals: Object.fromEntries(
          [...nodeTotals.entries()].sort(([left], [right]) => left - right),
        ),
        activeEdges: spread.activeEdges,
        nodeCount: spread.reachedNodes,
        edgeCount: spread.activeEdges,
        rerankedCount: mergedCandidates.length,
      },
      mergedCandidates,
    };
  }

  private async _nativeRerank(
    info: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<{
    output?: PipelineData;
    reason?: NativePropagationStructureFailure;
    failure?: NativePropagationStructureFailure;
  }> {
    const index = getTagRetrievalIndex(ctx);
    const dbPath = nativeDatabasePath(ctx);
    if (!index || !dbPath || typeof index.rerankByPropagationStructure !== "function") {
      return { reason: "backend_unavailable", failure: "backend_unavailable" };
    }

    let artifact = readRecord(info.tagGraphArtifact);
    if (typeof artifact.artifactSig !== "string" || !artifact.artifactSig) {
      const built = await ensureTagRetrievalArtifact(ctx, index);
      if (!built.state) {
        const failure: NativePropagationStructureFailure =
          built.failure === "invalid_result"
            ? "invalid_result"
            : "artifact_unavailable";
        return { reason: failure, failure };
      }
      artifact = built.state as unknown as Record<string, unknown>;
    }

    const candidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];
    if (candidates.length === 0) {
      return { reason: "invalid_result", failure: "invalid_result" };
    }

    const tagRetrieval = readRecord(info.tagRetrieval);
    const observation = readRecord(tagRetrieval.observation);
    const originalVector = this._vectorArray(
      info.nativeQueryVector ?? info.queryVector,
    );
    const enhancedVector = this._vectorArray(info.queryVector);
    const localVector = this._vectorArray(tagRetrieval.localVector);
    const transferVector = this._vectorArray(tagRetrieval.transferVector);
    const dimension = Math.max(0, Math.floor(Number(ctx.config.dimension) || 0));
    if (
      dimension <= 0 ||
      originalVector.length !== dimension ||
      enhancedVector.length !== dimension ||
      localVector.length !== dimension ||
      transferVector.length !== dimension
    ) {
      return { reason: "invalid_result", failure: "invalid_result" };
    }

    const nodes = Array.isArray(observation.nodes) ? observation.nodes : [];
    const edges = Array.isArray(observation.edges) ? observation.edges : [];
    const provenance = nodes.flatMap((node) => {
      const row = readRecord(node);
      const id = Number(row.id);
      if (!Number.isFinite(id)) return [];
      return [
        {
          id,
          hop: Number.isFinite(Number(row.hop)) ? Number(row.hop) : 0,
          sourceType: typeof row.sourceType === "string" ? row.sourceType : "",
        },
      ];
    });
    const tagRetrievalHandle =
      typeof tagRetrieval.observationHandle === "string"
        ? tagRetrieval.observationHandle
        : undefined;
    const options =
      info.options && typeof info.options === "object" ? info.options : {};
    const topK = Math.max(
      1,
      Math.floor(
        Number(
          (options as Record<string, unknown>).topK ??
            ctx.config.topK ??
            candidates.length,
        ) || 1,
      ),
    );
    const payload: Record<string, unknown> = {
      observationHandle: tagRetrievalHandle,
      dimension,
      topK,
      includeTrace: true,
      query: {
        text: typeof info.query === "string" ? info.query : "",
        vector: originalVector,
      },
      denoisedVector: enhancedVector,
      localVector,
      transferVector,
      candidates: candidates
        .map((candidate) => ({
          id: Number(candidate.chunkId),
          score: numeric(candidate.score),
        }))
        .filter((candidate) => Number.isFinite(candidate.id) && candidate.id > 0),
      queryState: {
        queryId: typeof info.queryId === "string" ? info.queryId : undefined,
        seedDistribution: readDistribution(observation.seedDistribution),
        localDistribution: readDistribution(tagRetrieval.localDistribution),
        extendedDistribution: readDistribution(tagRetrieval.extendedDistribution),
        localSupportIds: this._numberArray(tagRetrieval.localSupportIds),
        extendedSupportIds: this._numberArray(tagRetrieval.extendedSupportIds),
        propagationNodes: nodes,
        propagationEdges: edges,
        distributionProvenance: provenance,
        completeObservation: true,
      },
      allowedFileIds: [],
      config: {},
    };

    try {
      const runtime = createTagRetrievalRuntimeFacade(index, dbPath);
      const raw = await runtime.rerankByPropagationStructure(
        JSON.stringify(payload),
        String(artifact.artifactSig),
      );
      const output = readRecord(this._nativeRecord(raw));
      const nativeResults = Array.isArray(output.results) ? output.results : null;
      if (!nativeResults)
        return { reason: "invalid_result", failure: "invalid_result" };

      const originalById = new Map(
        candidates.map((candidate) => [Number(candidate.chunkId), candidate]),
      );
      const ranked: ChunkCandidate[] = [];
      const rankedIds = new Set<number>();
      for (const rawResult of nativeResults) {
        const result = readRecord(rawResult);
        const chunkId = Number(result.id ?? result.chunkId);
        if (!Number.isFinite(chunkId)) continue;
        const original = originalById.get(chunkId);
        const originalScore = this._finiteOr(
          result.originalScore ?? result.baseScore,
          numeric(original?.score),
        );
        const score = this._finiteOr(result.score, originalScore);
        ranked.push({
          ...(original || { chunkId, score: originalScore }),
          chunkId,
          score,
          structureScore: this._finiteOr(result.spreadScore, 0),
          structureBonus: this._finiteOr(result.structureBonus, 0),
          propagationScore: this._finiteOr(result.spreadScore, 0),
          propagationBonus: this._finiteOr(result.propagationBonus, 0),
          spreadClass:
            typeof result.spreadClass === "string" ? result.spreadClass : undefined,
          propagationStructureNative: result,
        });
        rankedIds.add(chunkId);
      }
      for (const candidate of candidates) {
        if (!rankedIds.has(Number(candidate.chunkId))) ranked.push(candidate);
      }
      if (ranked.length === 0)
        return { reason: "invalid_result", failure: "invalid_result" };

      const spread = readRecord(output.propagationSpread);
      const historySupport = Math.max(
        0,
        Math.min(1, numeric(info.propagationHistory?.historySupport)),
      );
      return {
        output: {
          ...info,
          mergedCandidates: ranked,
          propagationStructure: {
            schema:
              typeof output.schema === "string"
                ? output.schema
                : PROPAGATION_STRUCTURE_SCHEMA,
            algorithmVersion:
              typeof output.algorithmVersion === "string"
                ? output.algorithmVersion
                : undefined,
            spreadClass:
              typeof spread.spreadClass === "string"
                ? spread.spreadClass
                : typeof ranked[0]?.spreadClass === "string"
                  ? ranked[0].spreadClass
                  : "inactive",
            spreadScore: this._finiteOr(spread.spreadScore, 0),
            historySupport,
            activeEdges: Math.max(0, Math.round(this._finiteOr(spread.activeEdges, 0))),
            nodeCount: Math.max(0, Math.round(this._finiteOr(spread.reachedNodes, 0))),
            edgeCount: Math.max(0, Math.round(this._finiteOr(spread.activeEdges, 0))),
            rerankedCount: nativeResults.length,
            native: true,
            diagnostics: readRecord(output.diagnostics),
          },
          propagationStructureNative: output,
          propagationStructureSkipped: false,
        },
      };
    } catch {
      return { reason: "backend_unavailable", failure: "backend_unavailable" };
    }
  }

  private _nativeRecord(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    if (typeof value !== "string") return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private _vectorArray(value: unknown): number[] {
    if (!Array.isArray(value) && !(value instanceof Float32Array)) return [];
    return Array.from(value as ArrayLike<unknown>, (item) => numeric(item));
  }

  private _numberArray(value: unknown): number[] {
    return this._vectorArray(value).map((item) => Math.round(item));
  }

  private _finiteOr(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private _rerank(
    candidates: readonly ChunkCandidate[] | undefined,
    spreadClass: string,
    nodeTotals: Map<number, number>,
    config: MemoryConfigOverrides,
  ): ChunkCandidate[] {
    const source = Array.isArray(candidates) ? candidates : [];
    if (source.length === 0) return source;

    const inactive = spreadClass === "inactive";
    const cap = Math.max(0, numeric(config.historyRerankCap, 0.08));
    const results: ChunkCandidate[] = [];
    for (const candidate of source) {
      const tagIds = Array.isArray(candidate.tags)
        ? candidate.tags.map(Number).filter(Number.isFinite)
        : [];
      let support = 0;
      for (const id of tagIds) support = Math.max(support, numeric(nodeTotals.get(id)));
      const score = inactive
        ? numeric(candidate.score)
        : Math.max(
            0,
            Math.min(
              1,
              numeric(candidate.score) + Math.min(cap, cap * Math.min(1, support)),
            ),
          );
      results.push({
        ...candidate,
        score,
        historySupport: support,
        spreadClass,
      });
    }
    results.sort(
      (left, right) => right.score - left.score || left.chunkId - right.chunkId,
    );
    return results;
  }
}

export default PropagationStructureRerankerStage;
