import type { ChunkCandidate } from "../../types/documents.js";
import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";
import {
  ensureTagRetrievalArtifact,
  getTagRetrievalIndex,
  nativeDatabasePath,
  readDistribution,
  readRecord,
} from "../../native/tag-graph-artifact-runtime.js";
import { createTagRetrievalRuntimeFacade } from "../../native/tag-retrieval-runtime.js";
import type {
  NativePropagationStructureFailure,
  NativePropagationStructureResult,
} from "./propagation-structure-types.js";

function numeric(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Owns native ABI payload construction and result normalization. */
export default class PropagationStructureNativeAdapter {
  async rerank(
    info: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<NativePropagationStructureResult> {
    const index = getTagRetrievalIndex(ctx);
    const dbPath = nativeDatabasePath(ctx);
    if (!index || !dbPath || typeof index.rerankByPropagationStructure !== "function") {
      return this.failure("backend_unavailable");
    }

    let artifact = readRecord(info.tagGraphArtifact);
    if (typeof artifact.artifactSig !== "string" || !artifact.artifactSig) {
      const built = await ensureTagRetrievalArtifact(ctx, index);
      if (!built.state) {
        return this.failure(
          built.failure === "invalid_result"
            ? "invalid_result"
            : "artifact_unavailable",
        );
      }
      artifact = built.state as unknown as Record<string, unknown>;
    }

    const candidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];
    if (candidates.length === 0) return this.failure("invalid_result");

    const tagRetrieval = readRecord(info.tagRetrieval);
    const observation = readRecord(tagRetrieval.observation);
    const originalVector = this.vectorArray(info.nativeQueryVector ?? info.queryVector);
    const enhancedVector = this.vectorArray(info.queryVector);
    const localVector = this.vectorArray(tagRetrieval.localVector);
    const transferVector = this.vectorArray(tagRetrieval.transferVector);
    const dimension = Math.max(0, Math.floor(Number(ctx.config.dimension) || 0));
    if (
      dimension <= 0 ||
      originalVector.length !== dimension ||
      enhancedVector.length !== dimension ||
      localVector.length !== dimension ||
      transferVector.length !== dimension
    ) {
      return this.failure("invalid_result");
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
        localSupportIds: this.numberArray(tagRetrieval.localSupportIds),
        extendedSupportIds: this.numberArray(tagRetrieval.extendedSupportIds),
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
      const output = readRecord(this.nativeRecord(raw));
      const nativeResults = Array.isArray(output.results) ? output.results : null;
      if (!nativeResults) return this.failure("invalid_result");

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
        const originalScore = this.finiteOr(
          result.originalScore ?? result.baseScore,
          numeric(original?.score),
        );
        const score = this.finiteOr(result.score, originalScore);
        ranked.push({
          ...(original || { chunkId, score: originalScore }),
          chunkId,
          score,
          structureScore: this.finiteOr(result.spreadScore, 0),
          structureBonus: this.finiteOr(result.structureBonus, 0),
          propagationScore: this.finiteOr(result.spreadScore, 0),
          propagationBonus: this.finiteOr(result.propagationBonus, 0),
          spreadClass:
            typeof result.spreadClass === "string" ? result.spreadClass : undefined,
          propagationStructureNative: result,
        });
        rankedIds.add(chunkId);
      }
      for (const candidate of candidates) {
        if (!rankedIds.has(Number(candidate.chunkId))) ranked.push(candidate);
      }
      if (ranked.length === 0) return this.failure("invalid_result");

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
                : "propagation-structure-v1",
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
            spreadScore: this.finiteOr(spread.spreadScore, 0),
            historySupport,
            activeEdges: Math.max(0, Math.round(this.finiteOr(spread.activeEdges, 0))),
            nodeCount: Math.max(0, Math.round(this.finiteOr(spread.reachedNodes, 0))),
            edgeCount: Math.max(0, Math.round(this.finiteOr(spread.activeEdges, 0))),
            rerankedCount: nativeResults.length,
            native: true,
            diagnostics: readRecord(output.diagnostics),
          },
          propagationStructureNative: output,
          propagationStructureSkipped: false,
        },
      };
    } catch {
      return this.failure("backend_unavailable");
    }
  }

  private failure(
    reason: NativePropagationStructureFailure,
  ): NativePropagationStructureResult {
    return { reason, failure: reason };
  }

  private nativeRecord(value: unknown): Record<string, unknown> | null {
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

  private vectorArray(value: unknown): number[] {
    if (!Array.isArray(value) && !(value instanceof Float32Array)) return [];
    return Array.from(value as ArrayLike<unknown>, (item) => numeric(item));
  }

  private numberArray(value: unknown): number[] {
    return this.vectorArray(value).map((item) => Math.round(item));
  }

  private finiteOr(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}
