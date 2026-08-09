import type {
  ChunkCandidate,
  MetadataStoreContract,
  PipelineContextLike,
  PipelineData,
  SearchResult,
  UnknownRecord,
} from "../../types.js";

import Stage from "../../core/stage.js";
import * as path from "node:path";

type OutputCandidate = ChunkCandidate & {
  id?: number | null;
  text?: string;
  content?: string;
  path?: string;
  fullPath?: string;
  sourceFile?: string;
  fileId?: number | null;
  diaryName?: string;
  matchedTags?: string[];
  updatedAt?: number | null;
  updated_at?: number | null;
  mtime?: number | null;
  similarity?: number;
  memoScore?: number;
  tagMatchScore?: number;
  rerankScore?: number;
};

function parseRecord(value: string | null | undefined): UnknownRecord | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as UnknownRecord)
      : undefined;
  } catch (_error) {
    return undefined;
  }
}

/**
 * Output stage: assembles the final search result array.
 *
 * Mirrors the hydrated result shape returned by
 * modules/knowledgeBase/searchService.js (chunk text, path, per-chunk tags,
 * score) while normalizing field names:
 *
 *   {
 *     id, chunkId, content, path, sourceFile, fileId, diaryName,
 *     score, similarity, updatedAt, mtime, tags, matchedTags,
 *     memoScore, source, decay, rerankScore, original_score(s)
 *   }
 *
 * Missing fields are hydrated from ctx.metadataStore via getChunkById /
 * getFileByChunkId / getFileTags. Candidates that already carry complete
 * field values pass through unharmed. TagMemo / EPA / pyramid traces in the
 * input are preserved on the output envelope.
 *
 * Input: { query, mergedCandidates, tagMemo?, pyramid?, epa? }
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
      results.push(await this._formatCandidate(candidate, ctx, store));
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
        chunk = null;
      }
    }
    if (chunk && store && typeof store.getFileByChunkId === "function") {
      try {
        file = await store.getFileByChunkId(chunk.id);
      } catch (error) {
        file = null;
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
          ? tagRows.map((t) => (t && t.name) || String(t))
          : [];
      } catch (error) {
        tags = [];
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
      diaryName: file?.diary_name ?? outputCandidate?.diaryName ?? "",
      score,
      similarity: Number.isFinite(Number(outputCandidate?.similarity))
        ? Number(outputCandidate.similarity)
        : score,
      updatedAt:
        file?.updated_at ??
        outputCandidate?.updatedAt ??
        outputCandidate?.updated_at ??
        null,
      mtime: file?.mtime ?? outputCandidate?.mtime ?? null,
      tags,
      matchedTags: outputCandidate?.matchedTags ?? tags,
      documentId: file?.document_id ?? undefined,
      revision: file?.revision ?? undefined,
      sourceMetadata: parseRecord(file?.source_json),
      metadata: parseRecord(file?.metadata_json),
      memoScore: Number.isFinite(Number(outputCandidate?.memoScore))
        ? Number(outputCandidate.memoScore)
        : Number.isFinite(Number(outputCandidate?.tagMatchScore))
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
}

export default ResultFormatterStage;
