import type {
  ChunkCandidate,
  EmbeddingVector,
  TagExpansionData,
  PipelineContextLike,
  PipelineData,
  TagRow,
} from "../../types.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";
import { decodeVectorBlob } from "../../utils/vector-codec.js";
import { at } from "../../utils/numerical.js";

// Shared global tag vector index name (mirror of VectorIndexerStage).
const TAG_INDEX_NAME = "tag_vectors";

/**
 * TagExpanderStage — semantic tag-driven candidate expansion.
 *
 * The candidate pool produced by CandidateMergerStage is enlarged through
 * the tag index: the tags of the candidate chunks form a query vector
 * (mean of their tag vectors), the `tag_vectors` index is searched for
 * semantically similar tags, and the chunks of the files carrying those
 * tags are added to the pool with a decayed score (expansionBoost).
 *
 * The original KBM search flow has no candidate-level tag expansion
 * (searchSimilarTags exists only as a standalone helper), so the stage
 * is gated by `tagExpansionEnabled` and OFF by default.
 *
 * Input:  { queryVector?, mergedCandidates: [{ chunkId, score, ... }] }
 * Config (ctx.config):
 *   - tagExpansionEnabled     gate (default false)
 *   - tagVectorTopK        similar tags fetched (default 5)
 *   - expansionBoost       decay multiplier for expanded chunks (default 0.5)
 *   - tagVectorIndexName            tag index to search (default 'tag_vectors')
 *   - dimension               vector dimension (tag-vector decode)
 * Context (ctx):
 *   - ctx.vectorStore         searched for similar tags
 *   - ctx.metadataStore       chunk -> file -> tags joins and chunk lookup
 *
 * Output: { ..., mergedCandidates: expandedPool, tagExpansion:
 *          { added, boosted } } or tagExpansionSkipped: true.
 */
class TagExpanderStage extends Stage {
  constructor() {
    super();
    this.name = "tagExpander";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "mergedCandidates" | "tagExpansion"> & {
      mergedCandidates: ChunkCandidate[];
      tagExpansion?: TagExpansionData;
      tagExpansionSkipped?: boolean;
    }
  > {
    const info = input || {};
    const config = ctx.config;
    const mergedCandidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];
    const resolvedScope = Array.isArray(info.resolvedIndexNames)
      ? new Set(info.resolvedIndexNames.map((name) => String(name)))
      : null;
    const allowedChunkIds =
      info.allowedChunkIds instanceof Set ? info.allowedChunkIds : null;

    if (resolvedScope?.size === 0) {
      return {
        ...info,
        mergedCandidates: [],
        tagExpansion: { added: [], boosted: [] },
      };
    }

    if (!config.tagExpansionEnabled) {
      return { ...info, mergedCandidates, tagExpansionSkipped: true };
    }
    const metadataStore = ctx.metadataStore;
    const vectorStore = ctx.vectorStore;
    if (
      mergedCandidates.length === 0 ||
      !metadataStore ||
      !vectorStore ||
      typeof vectorStore.search !== "function"
    ) {
      return {
        ...info,
        mergedCandidates,
        tagExpansion: { added: [], boosted: [] },
      };
    }

    // 1. Collect the tag set behind the candidate chunks.
    const scopedCandidates = [];
    for (const candidate of mergedCandidates) {
      if (
        await this._chunkInScope(
          Number(candidate.chunkId),
          resolvedScope,
          allowedChunkIds,
          metadataStore,
        )
      ) {
        scopedCandidates.push(candidate);
      }
    }
    if (scopedCandidates.length === 0) {
      return {
        ...info,
        mergedCandidates: [],
        tagExpansion: { added: [], boosted: [] },
      };
    }

    const candidateTags = await this._collectCandidateTags(
      scopedCandidates,
      metadataStore,
      resolvedScope,
      allowedChunkIds,
    );
    const candidateTagIds = new Set(candidateTags.map((t) => Number(t.id)));

    // 2. Semantic query vector: mean of the candidate tag vectors,
    //    falling back to the raw query vector when tags lack vectors.
    const expansionVector = await this._expansionVector(
      candidateTags,
      info.queryVector,
      metadataStore,
    );
    if (!expansionVector) {
      return {
        ...info,
        mergedCandidates,
        tagExpansion: { added: [], boosted: [] },
      };
    }

    // 3. Search the tag index for semantically similar tags.
    const topK = Math.max(1, Math.round(Number(config.tagVectorTopK) || 5));
    const tagVectorIndexName = config.tagVectorIndexName || TAG_INDEX_NAME;
    let hits: Array<{ id: number; score: number }> = [];
    try {
      hits = await vectorStore.search(tagVectorIndexName, expansionVector, topK);
    } catch (e) {
      throw asMemoriaError(
        e,
        "vector_backend",
        `TagExpander tag index search failed for "${tagVectorIndexName}".`,
        { retryable: true },
      );
    }

    const rawBoost = Number(config.expansionBoost);
    const expansionBoost = Number.isFinite(rawBoost) && rawBoost > 0 ? rawBoost : 0.5;
    const maxHitScore =
      (hits || []).reduce((max, h) => Math.max(max, Number(h.score) || 0), 0) || 1;

    // 4. Expand: chunks of files carrying a similar tag join the pool
    //    with a decayed score; pool members re-reached via expansion
    //    are recorded as boosted (score unchanged).
    const pool = new Map();
    for (const candidate of scopedCandidates) {
      pool.set(Number(candidate.chunkId), { ...candidate });
    }

    const added = [];
    const boosted: number[] = [];
    for (const hit of hits || []) {
      const tagId = Number(hit.id);
      if (!Number.isFinite(tagId) || candidateTagIds.has(tagId)) continue;
      const normalized = (Number(hit.score) || 0) / maxHitScore;

      let fileIds = [];
      try {
        fileIds = await metadataStore.getFileIdsByTagId(tagId);
      } catch (e) {
        throw asMemoriaError(
          e,
          "persistence",
          "Metadata store failed while expanding a search tag to files.",
          { retryable: true },
        );
      }
      for (const fileId of fileIds || []) {
        let chunks = [];
        try {
          chunks = await metadataStore.getChunksByFileId(fileId);
        } catch (e) {
          throw asMemoriaError(
            e,
            "persistence",
            "Metadata store failed while expanding a search file to chunks.",
            { retryable: true },
          );
        }
        for (const chunk of chunks || []) {
          const chunkId = Number(chunk.id);
          if (!Number.isFinite(chunkId)) continue;
          if (
            !(await this._chunkInScope(
              chunkId,
              resolvedScope,
              allowedChunkIds,
              metadataStore,
            ))
          ) {
            continue;
          }
          const previous = pool.get(chunkId);
          if (previous) {
            if (!boosted.includes(chunkId)) boosted.push(chunkId);
            continue;
          }
          const entry = {
            chunkId,
            score: expansionBoost * normalized,
            source: "tag-expansion",
          };
          pool.set(chunkId, entry);
          added.push(chunkId);
        }
      }
    }

    const expandedPool = [...pool.values()].sort(
      (a, b) => b.score - a.score || a.chunkId - b.chunkId,
    );

    return {
      ...info,
      mergedCandidates: expandedPool,
      tagExpansion: { added, boosted },
    };
  }

  async _collectCandidateTags(
    candidates: readonly ChunkCandidate[],
    metadataStore: NonNullable<PipelineContextLike["metadataStore"]>,
    scope: Set<string> | null,
    allowedChunkIds: Set<unknown> | null,
  ): Promise<Array<{ id: number; name?: string }>> {
    if (typeof metadataStore.getFileByChunkId !== "function") return [];
    const seen = new Map<number, { id: number; name?: string }>();
    for (const candidate of candidates) {
      const chunkId = Number(candidate && candidate.chunkId);
      if (!Number.isFinite(chunkId)) continue;
      if (!(await this._chunkInScope(chunkId, scope, allowedChunkIds, metadataStore)))
        continue;
      let file = null;
      try {
        file = await metadataStore.getFileByChunkId(chunkId);
      } catch (e) {
        throw asMemoriaError(
          e,
          "persistence",
          "Metadata store failed while resolving candidate tags.",
          { retryable: true },
        );
      }
      if (!file) continue;
      if (typeof metadataStore.getFileTags !== "function") continue;
      let tags = [];
      try {
        tags = await metadataStore.getFileTags(file.id);
      } catch (e) {
        throw asMemoriaError(
          e,
          "persistence",
          "Metadata store failed while loading candidate tags.",
          { retryable: true },
        );
      }
      for (const tag of tags || []) {
        const tagId = Number(tag.id);
        if (!Number.isFinite(tagId)) continue;
        if (!seen.has(tagId)) seen.set(tagId, { id: tagId, name: tag.name });
      }
    }
    return [...seen.values()];
  }

  private async _chunkInScope(
    chunkId: number,
    scope: Set<string> | null,
    allowedChunkIds: Set<unknown> | null,
    metadataStore: NonNullable<PipelineContextLike["metadataStore"]>,
  ): Promise<boolean> {
    if (allowedChunkIds) {
      return allowedChunkIds.has(chunkId) || allowedChunkIds.has(String(chunkId));
    }
    if (scope === null) return true;
    if (scope.size === 0 || typeof metadataStore.getFileByChunkId !== "function") {
      return false;
    }
    const file = await metadataStore.getFileByChunkId(chunkId);
    const indexName = file?.space || "Root";
    return !!file && scope.has(indexName);
  }

  async _expansionVector(
    candidateTags: readonly { id: number; name?: string }[],
    queryVector: EmbeddingVector | undefined,
    metadataStore: NonNullable<PipelineContextLike["metadataStore"]>,
  ): Promise<EmbeddingVector | null> {
    if (candidateTags.length === 0) {
      return queryVector || null;
    }
    if (typeof metadataStore.getAllTags !== "function") {
      return queryVector || null;
    }
    let tagPool: TagRow[] = [];
    try {
      tagPool =
        typeof metadataStore.getActiveTags === "function"
          ? await metadataStore.getActiveTags()
          : await metadataStore.getAllTags();
    } catch (e) {
      throw asMemoriaError(
        e,
        "persistence",
        "Metadata store failed while loading tag vectors for expansion.",
        { retryable: true },
      );
    }
    const byId = new Map((tagPool || []).map((t) => [Number(t.id), t]));

    const dimension = this._resolveDimension(
      metadataStore.dimension,
      queryVector,
      tagPool,
    );
    const components: Float32Array[] = [];
    for (const tag of candidateTags) {
      const row = byId.get(Number(tag.id));
      if (!row || row.vector == null) continue;
      const vector = decodeVectorBlob(row.vector, dimension, `tag:${tag.id}`);
      if (vector) components.push(vector);
    }
    if (components.length === 0) return queryVector || null;

    const mean = new Float32Array(dimension);
    for (const vector of components) {
      for (let d = 0; d < dimension; d++) {
        mean[d] = at(mean, d, "tag mean") + at(vector, d, "tag vector");
      }
    }
    for (let d = 0; d < dimension; d++)
      mean[d] = at(mean, d, "tag mean") / components.length;
    return mean;
  }

  _resolveDimension(
    configDimension: number | null | undefined,
    queryVector: EmbeddingVector | undefined,
    tagPool: readonly TagRow[],
  ): number {
    if (configDimension && Number.isFinite(Number(configDimension))) {
      return Number(configDimension);
    }
    if (queryVector && queryVector.length > 0) return queryVector.length;
    for (const tag of tagPool || []) {
      const vector: unknown = tag.vector;
      if (vector instanceof Float32Array && vector.length > 0) {
        return vector.length;
      }
    }
    return 3072;
  }
}

export default TagExpanderStage;
