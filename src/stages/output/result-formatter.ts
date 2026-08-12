import type { ChunkCandidate, SearchResult } from "../../types/documents.js";
import type { MetadataStoreContract } from "../../types/metadata.js";
import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";
import type { UnknownRecord } from "../../types/common.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";
import * as path from "node:path";

type OutputCandidate = ChunkCandidate & {
  id?: number | null;
  text?: string;
  content?: string;
  path?: string;
  fullPath?: string;
  sourceFile?: string;
  fileId?: number | null;
  space?: string;
  matchedTags?: string[];
  sourceUpdatedAt?: number | null;
  recordedAt?: number | null;
  indexedAt?: number | null;
  similarity?: number;
  tagMatchScore?: number;
  rerankScore?: number;
  associationChannel?: "tag" | "vector";
  associationOf?: number;
};

function parseRecord(value: string | null | undefined): UnknownRecord | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as UnknownRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Output stage: assembles the final search result array.
 *
 * Mirrors the hydrated result shape returned by
 * the metadata/search contract (chunk text, path, per-chunk tags, score) while
 * normalizing field names:
 *
 *   {
 *     id, chunkId, content, path, sourceFile, fileId, space,
 *     score, similarity, sourceUpdatedAt, recordedAt, indexedAt, tags, matchedTags,
 *     tagMatchScore, source, decay, rerankScore, original_score(s)
 *   }
 *
 * Missing fields are hydrated from ctx.metadataStore via getChunkById /
 * getFileByChunkId / getFileTags. Candidates that already carry complete
 * field values pass through unharmed. TagGraphPropagation / TagBasisProjection / tagResidualDecomposition traces in the
 * input are preserved on the output envelope. When truncation is enabled,
 * final hydrated content is capped here as well, so vector-only candidates
 * cannot bypass maxContentLength.
 *
 * Input: { query, mergedCandidates, tagGraphPropagation?, tagResidualDecomposition?, tagBasisProjection? }
 * Output: { ..., results: [...], resultCount }
 */
class ResultFormatterStage extends Stage {
  constructor() {
    super();
    this.name = "resultFormatter";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "results" | "resultCount"> & {
      results: SearchResult[];
      resultCount: number;
    }
  > {
    const info = input || {};
    const candidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];
    const store = ctx.metadataStore;

    const results: SearchResult[] = [];
    for (const candidate of candidates) {
      const formatted = await this._formatCandidate(candidate, ctx, store);
      results.push(this._applyContentCap(formatted, ctx));
    }
    results.sort((a, b) => b.score - a.score || Number(a.id) - Number(b.id));

    return { ...info, results, resultCount: results.length };
  }

  async _formatCandidate(
    candidate: ChunkCandidate,
    _ctx: PipelineContextLike,
    store: MetadataStoreContract | null | undefined,
  ): Promise<SearchResult> {
    const outputCandidate = candidate as OutputCandidate;
    const chunkId = Number(candidate && candidate.chunkId);
    const id = Number.isFinite(chunkId)
      ? chunkId
      : Number(outputCandidate && outputCandidate.id) || null;

    let chunk = null;
    let file = null;
    if (
      id !== null &&
      Number.isFinite(id) &&
      store &&
      typeof store.getChunkById === "function"
    ) {
      try {
        chunk = await store.getChunkById(id);
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Metadata store failed while hydrating a search chunk.",
          { retryable: true },
        );
      }
    }
    if (chunk && store && typeof store.getFileByChunkId === "function") {
      try {
        file = await store.getFileByChunkId(chunk.id);
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Metadata store failed while hydrating a search file.",
          { retryable: true },
        );
      }
    }

    const content =
      outputCandidate?.content ?? outputCandidate?.text ?? chunk?.content ?? "";
    const fullPath =
      file?.path ?? outputCandidate?.path ?? outputCandidate?.fullPath ?? "";

    let tags = outputCandidate?.tags;
    if (
      !Array.isArray(tags) &&
      file &&
      store &&
      typeof store.getFileTags === "function"
    ) {
      try {
        const tagRows = await store.getFileTags(file.id);
        tags = Array.isArray(tagRows)
          ? tagRows.map((t) => (t && typeof t.name === "string" ? t.name : ""))
          : [];
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Metadata store failed while hydrating search tags.",
          { retryable: true },
        );
      }
    }
    if (!Array.isArray(tags)) {
      tags = Array.isArray(outputCandidate?.matchedTags)
        ? outputCandidate.matchedTags
        : [];
    }

    const score = Number(outputCandidate?.score) || 0;

    return {
      id,
      chunkId: Number.isFinite(chunkId) ? chunkId : id,
      content,
      path: fullPath,
      sourceFile: fullPath
        ? path.basename(fullPath)
        : outputCandidate?.sourceFile || "",
      fileId: file?.id ?? outputCandidate?.fileId ?? null,
      space: file?.space ?? outputCandidate?.space ?? "",
      score,
      similarity: Number.isFinite(Number(outputCandidate?.similarity))
        ? Number(outputCandidate.similarity)
        : score,
      sourceUpdatedAt:
        file?.source_updated_at ?? outputCandidate?.sourceUpdatedAt ?? null,
      recordedAt: file?.recorded_at ?? outputCandidate?.recordedAt ?? null,
      indexedAt: file?.indexed_at ?? outputCandidate?.indexedAt ?? null,
      tags,
      matchedTags: outputCandidate?.matchedTags ?? tags,
      documentId: file?.document_id ?? undefined,
      revision: file?.revision ?? undefined,
      sourceMetadata: parseRecord(file?.source_json),
      metadata: parseRecord(file?.metadata_json),
      associationChannel: outputCandidate?.associationChannel,
      associationOf: Number.isFinite(Number(outputCandidate?.associationOf))
        ? Number(outputCandidate.associationOf)
        : undefined,
      tagMatchScore: Number.isFinite(Number(outputCandidate?.tagMatchScore))
        ? Number(outputCandidate.tagMatchScore)
        : undefined,
      source: outputCandidate?.source ?? null,
      decay: Number.isFinite(Number(outputCandidate?.decay))
        ? Number(outputCandidate.decay)
        : undefined,
      rerankScore: Number.isFinite(Number(outputCandidate?.rerankScore))
        ? Number(outputCandidate.rerankScore)
        : undefined,
    };
  }

  _applyContentCap(result: SearchResult, ctx: PipelineContextLike): SearchResult {
    if (ctx.config?.truncateEnabled !== true) return result;
    const configured = Number(ctx.config.maxContentLength);
    if (!Number.isFinite(configured) || configured <= 0) return result;
    const limit = Math.floor(configured);
    const content = String(result.content ?? "");
    const text = typeof result.text === "string" ? result.text : undefined;
    const suffix = ctx.config.truncateEllipsis === true ? "…" : "";
    const cappedContent =
      content.length > limit ? content.slice(0, limit) + suffix : content;
    const cappedText =
      text !== undefined && text.length > limit ? text.slice(0, limit) + suffix : text;
    if (cappedContent === content && cappedText === text) return result;
    return {
      ...result,
      content: cappedContent,
      ...(cappedText !== undefined ? { text: cappedText } : {}),
    };
  }
}

export default ResultFormatterStage;
