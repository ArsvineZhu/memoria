import type {
  AssociatorStats,
  ChunkCandidate,
  FileRow,
  MemoryConfigOverrides,
  PipelineContextLike,
  PipelineData,
  VectorHit,
} from "../../types.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";
import { decodeVectorBlob } from "../../utils/vector-codec.js";

const TAG_INDEX_NAME = "global_tags";
const DEFAULT_ASSOCIATE_COUNT = 10;
const DEFAULT_SEED_COUNT = 3;
const DEFAULT_TAG_BOOST = 0.45;
const DEFAULT_VECTOR_K = 5;
const DEFAULT_VECTOR_BOOST = 0.3;

type AssociationChannel = "tag" | "vector";

interface AssociationProposal {
  chunkId: number;
  score: number;
  channel: AssociationChannel;
  seedChunkId: number;
}

/**
 * Adds related chunks discovered from tag co-occurrence and scoped vector
 * neighbors. It deliberately works only with the existing metadata/vector
 * contracts; proposals are hydrated by ResultFormatterStage later.
 */
class AssociatorStage extends Stage {
  constructor() {
    super();
    this.name = "associator";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "mergedCandidates" | "associatorStats"> & {
      mergedCandidates: ChunkCandidate[];
      associatorStats: AssociatorStats;
      associatorSkipped?: boolean;
    }
  > {
    const info = input || {};
    let candidates = Array.isArray(info.mergedCandidates) ? info.mergedCandidates : [];
    const resolvedScope = Array.isArray(info.resolvedIndexNames)
      ? new Set(info.resolvedIndexNames.map((name) => String(name)))
      : null;
    const stats: AssociatorStats = {
      added: 0,
      fromTags: 0,
      fromVector: 0,
      skipped: 0,
    };

    if (resolvedScope?.size === 0) {
      return {
        ...info,
        mergedCandidates: [],
        associatorStats: stats,
        associatorSkipped: true,
      };
    }

    if (ctx.config?.associatorEnabled !== true || candidates.length === 0) {
      return {
        ...info,
        mergedCandidates: candidates,
        associatorStats: stats,
        associatorSkipped: true,
      };
    }

    const config = ctx.config || {};
    const seedCount = this._positiveInteger(
      config.associatorSeeds,
      DEFAULT_SEED_COUNT,
      true,
    );
    const associateCount = this._positiveInteger(
      config.associateCount,
      DEFAULT_ASSOCIATE_COUNT,
      true,
    );
    if (resolvedScope !== null) {
      const scopedCandidates: ChunkCandidate[] = [];
      for (const candidate of candidates) {
        if (await this._chunkInScope(Number(candidate.chunkId), resolvedScope, ctx)) {
          scopedCandidates.push(candidate);
        }
      }
      candidates = scopedCandidates;
    }
    if (candidates.length === 0) {
      return {
        ...info,
        mergedCandidates: [],
        associatorStats: stats,
        associatorSkipped: true,
      };
    }
    const seeds = candidates.slice(0, seedCount);
    if (seeds.length === 0 || associateCount === 0) {
      return {
        ...info,
        mergedCandidates: candidates,
        associatorStats: stats,
        associatorSkipped: true,
      };
    }

    const presentIds = new Set<number>();
    for (const candidate of candidates) {
      const chunkId = Number(candidate && candidate.chunkId);
      if (Number.isFinite(chunkId)) presentIds.add(chunkId);
    }
    const proposals = new Map<number, AssociationProposal>();
    const metadataStore = ctx.metadataStore;
    const canUseTags = this._canUseTagChannel(metadataStore);
    if (canUseTags && resolvedScope !== null) {
      let matrix: Map<number, Map<number, number>>;
      try {
        matrix = await metadataStore!.buildCooccurrenceMatrix!();
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Metadata store failed while building associator co-occurrence data.",
          { retryable: true },
        );
      }
      if (!(matrix instanceof Map)) matrix = new Map();
      for (const seed of seeds) {
        await this._collectTagProposals(
          seed,
          matrix,
          resolvedScope,
          ctx,
          proposals,
          presentIds,
          config,
          stats,
        );
      }
    } else {
      stats.skipped += seeds.length;
    }

    if (config.associatorUseVector !== false) {
      if (this._canUseVectorChannel(ctx, resolvedScope)) {
        for (const seed of seeds) {
          await this._collectVectorProposals(
            seed,
            resolvedScope!,
            ctx,
            proposals,
            presentIds,
            config,
            stats,
          );
        }
      } else {
        stats.skipped += seeds.length;
      }
    }

    const selected = [...proposals.values()]
      .sort((left, right) => this._compareProposals(left, right))
      .slice(0, associateCount);

    if (selected.length === 0) {
      return {
        ...info,
        mergedCandidates: candidates,
        associatorStats: stats,
        ...(stats.skipped > 0 ? { associatorSkipped: true } : {}),
      };
    }

    const additions = selected.map((proposal) => {
      if (proposal.channel === "tag") stats.fromTags += 1;
      else stats.fromVector += 1;
      return {
        chunkId: proposal.chunkId,
        score: proposal.score,
        source: "associate",
        associationChannel: proposal.channel,
        associationOf: proposal.seedChunkId,
      };
    });
    stats.added = additions.length;

    const mergedCandidates = [...candidates, ...additions].sort(
      (left, right) =>
        this._score(right.score) - this._score(left.score) ||
        this._channelPriority(left) - this._channelPriority(right) ||
        this._compareChunkIds(left.chunkId, right.chunkId),
    );

    return {
      ...info,
      mergedCandidates,
      associatorStats: stats,
      ...(stats.skipped > 0 ? { associatorSkipped: true } : {}),
    };
  }

  private async _collectTagProposals(
    seed: ChunkCandidate,
    matrix: Map<number, Map<number, number>>,
    scope: Set<string> | null,
    ctx: PipelineContextLike,
    proposals: Map<number, AssociationProposal>,
    presentIds: Set<number>,
    config: MemoryConfigOverrides,
    stats: AssociatorStats,
  ): Promise<void> {
    const store = ctx.metadataStore!;
    const seedChunkId = Number(seed.chunkId);
    if (!Number.isFinite(seedChunkId)) {
      stats.skipped += 1;
      return;
    }

    let seedFile: FileRow | null;
    try {
      seedFile = await store.getFileByChunkId(seedChunkId);
    } catch (error) {
      throw asMemoriaError(
        error,
        "persistence",
        "Metadata store failed while resolving an associator seed file.",
        { retryable: true },
      );
    }
    if (!seedFile) {
      stats.skipped += 1;
      return;
    }

    let fileTags;
    try {
      fileTags = await store.getFileTags(seedFile.id);
    } catch (error) {
      throw asMemoriaError(
        error,
        "persistence",
        "Metadata store failed while loading associator seed tags.",
        { retryable: true },
      );
    }

    const tagIds = await this._resolveTagIds(fileTags, store);
    const neighborWeights = new Map<number, number>();
    for (const tagId of tagIds) {
      const neighbors = matrix.get(tagId);
      if (!(neighbors instanceof Map)) continue;
      for (const [neighborId, rawWeight] of neighbors) {
        const weight = Number(rawWeight);
        if (!Number.isFinite(weight) || weight <= 0 || neighborId === tagId) continue;
        neighborWeights.set(
          neighborId,
          (neighborWeights.get(neighborId) || 0) + weight,
        );
      }
    }

    const orderedNeighbors = [...neighborWeights.entries()].sort(
      (left, right) => right[1] - left[1] || left[0] - right[0],
    );
    const maxWeight = orderedNeighbors[0]?.[1] ?? 0;
    if (!(maxWeight > 0)) return;

    const tagBoost = this._number(config.associatorTagBoost, DEFAULT_TAG_BOOST);
    const seedScore = this._score(seed.score);
    for (const [neighborId, weight] of orderedNeighbors) {
      let fileIds;
      try {
        fileIds = await store.getFileIdsByTagId(neighborId);
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Metadata store failed while finding associator tag neighbors.",
          { retryable: true },
        );
      }
      if (!Array.isArray(fileIds)) continue;

      const normalizedCooccurrence = weight / maxWeight;
      for (const rawFileId of fileIds) {
        const fileId = Number(rawFileId);
        if (!Number.isFinite(fileId)) continue;
        let chunks;
        try {
          chunks = await store.getChunksByFileId(fileId);
        } catch (error) {
          throw asMemoriaError(
            error,
            "persistence",
            "Metadata store failed while loading associator tag chunks.",
            { retryable: true },
          );
        }
        if (!Array.isArray(chunks)) continue;

        for (const chunk of chunks) {
          const chunkId = Number(chunk && chunk.id);
          if (!Number.isFinite(chunkId) || presentIds.has(chunkId)) continue;
          if (!(await this._chunkInScope(chunkId, scope, ctx))) continue;
          this._mergeProposal(
            proposals,
            {
              chunkId,
              score: seedScore * tagBoost * normalizedCooccurrence,
              channel: "tag",
              seedChunkId,
            },
            presentIds,
          );
        }
      }
    }
  }

  private async _collectVectorProposals(
    seed: ChunkCandidate,
    scope: Set<string>,
    ctx: PipelineContextLike,
    proposals: Map<number, AssociationProposal>,
    presentIds: Set<number>,
    config: MemoryConfigOverrides,
    stats: AssociatorStats,
  ): Promise<void> {
    const store = ctx.metadataStore;
    const vectorStore = ctx.vectorStore!;
    const seedChunkId = Number(seed.chunkId);
    if (!Number.isFinite(seedChunkId)) {
      stats.skipped += 1;
      return;
    }

    let vector = this._candidateVector(seed, config);
    if (!vector && store && typeof store.getChunkById === "function") {
      let row;
      try {
        row = await store.getChunkById(seedChunkId);
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Metadata store failed while loading an associator seed vector.",
          { retryable: true },
        );
      }
      const dimension = this._dimension(config, row?.vector);
      vector = row?.vector
        ? decodeVectorBlob(row.vector, dimension, `chunk:${seedChunkId}`)
        : null;
    }
    if (!vector) {
      stats.skipped += 1;
      return;
    }

    const vectorK = this._positiveInteger(config.associatorVecK, DEFAULT_VECTOR_K);
    const hitsById = new Map<number, number>();
    for (const indexName of scope) {
      if (indexName === TAG_INDEX_NAME) continue;
      let hits: VectorHit[];
      try {
        hits = await vectorStore.search(indexName, vector, vectorK);
      } catch (error) {
        throw asMemoriaError(
          error,
          "vector_backend",
          "Vector store failed while searching associator neighbors.",
          { retryable: true },
        );
      }
      if (!Array.isArray(hits)) continue;
      for (const hit of hits) {
        const chunkId = Number(hit && hit.id);
        const score = this._score(hit && hit.score);
        if (!Number.isFinite(chunkId)) continue;
        const existing = hitsById.get(chunkId);
        if (existing === undefined || score > existing) hitsById.set(chunkId, score);
      }
    }

    const scopedHits: Array<[number, number]> = [];
    for (const [chunkId, hitScore] of hitsById) {
      if (chunkId === seedChunkId) continue;
      if (!(await this._chunkInScope(chunkId, scope, ctx))) continue;
      scopedHits.push([chunkId, hitScore]);
    }
    const topHits = scopedHits
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])
      .slice(0, vectorK);
    const maxHit = Math.max(
      0,
      ...topHits.map((entry) => (entry[1] > 0 ? entry[1] : 0)),
    );
    if (!(maxHit > 0)) return;

    const vectorBoost = this._number(config.associatorVecBoost, DEFAULT_VECTOR_BOOST);
    for (const [chunkId, hitScore] of topHits) {
      if (!(hitScore > 0) || presentIds.has(chunkId)) continue;
      this._mergeProposal(
        proposals,
        {
          chunkId,
          score: this._score(seed.score) * vectorBoost * (hitScore / maxHit),
          channel: "vector",
          seedChunkId,
        },
        presentIds,
      );
    }
  }

  private _canUseTagChannel(store: PipelineContextLike["metadataStore"]): boolean {
    return !!(
      store &&
      typeof store.buildCooccurrenceMatrix === "function" &&
      typeof store.getFileByChunkId === "function" &&
      typeof store.getFileTags === "function" &&
      typeof store.getFileIdsByTagId === "function" &&
      typeof store.getChunksByFileId === "function"
    );
  }

  private _canUseVectorChannel(
    ctx: PipelineContextLike,
    scope: Set<string> | null,
  ): boolean {
    return !!(
      scope &&
      [...scope].some((name) => name !== TAG_INDEX_NAME) &&
      ctx.vectorStore &&
      typeof ctx.vectorStore.search === "function"
    );
  }

  private _candidateVector(
    seed: ChunkCandidate,
    config: MemoryConfigOverrides,
  ): Float32Array | null {
    const raw = seed.vector;
    if (raw instanceof Float32Array) {
      const dimension = this._dimension(config, raw);
      return raw.length === dimension ? raw : null;
    }
    if (Array.isArray(raw)) {
      const dimension = this._dimension(config, raw);
      if (
        raw.length !== dimension ||
        raw.some((value) => !Number.isFinite(Number(value)))
      ) {
        return null;
      }
      return new Float32Array(raw.map(Number));
    }
    return null;
  }

  private async _resolveTagIds(
    rows: unknown,
    store: NonNullable<PipelineContextLike["metadataStore"]>,
  ): Promise<number[]> {
    if (!Array.isArray(rows)) return [];
    const ids: number[] = [];
    for (const row of rows) {
      const value = row as {
        tagId?: unknown;
        tag_id?: unknown;
        id?: unknown;
        name?: unknown;
      };
      const direct = Number(value.tagId ?? value.tag_id ?? value.id);
      if (Number.isFinite(direct)) {
        ids.push(direct);
        continue;
      }
      if (typeof value.name === "string" && typeof store.getTagByName === "function") {
        let tag;
        try {
          tag = await store.getTagByName(value.name);
        } catch (error) {
          throw asMemoriaError(
            error,
            "persistence",
            "Metadata store failed while resolving associator tags.",
            { retryable: true },
          );
        }
        const tagId = Number(tag?.id);
        if (Number.isFinite(tagId)) ids.push(tagId);
      }
    }
    return [...new Set(ids)];
  }

  private async _chunkInScope(
    chunkId: number,
    scope: Set<string> | null,
    ctx: PipelineContextLike,
  ): Promise<boolean> {
    if (scope === null) return false;
    if (scope.size === 0) return false;
    const store = ctx.metadataStore;
    if (!store || typeof store.getFileByChunkId !== "function") return false;
    let file;
    try {
      file = await store.getFileByChunkId(chunkId);
    } catch (error) {
      throw asMemoriaError(
        error,
        "persistence",
        "Metadata store failed while checking associator scope.",
        { retryable: true },
      );
    }
    return !!file && scope.has(this._diaryName(file));
  }

  private _diaryName(file: FileRow): string {
    return String(file.diary_name ?? file.diaryName ?? "");
  }

  private _mergeProposal(
    proposals: Map<number, AssociationProposal>,
    proposal: AssociationProposal,
    presentIds: Set<number>,
  ): void {
    if (presentIds.has(proposal.chunkId)) return;
    const previous = proposals.get(proposal.chunkId);
    if (
      !previous ||
      proposal.score > previous.score ||
      (proposal.score === previous.score &&
        proposal.channel === "tag" &&
        previous.channel === "vector")
    ) {
      proposals.set(proposal.chunkId, proposal);
    }
  }

  private _compareProposals(
    left: AssociationProposal,
    right: AssociationProposal,
  ): number {
    return (
      this._score(right.score) - this._score(left.score) ||
      this._channelPriority(left) - this._channelPriority(right) ||
      this._compareChunkIds(left.chunkId, right.chunkId)
    );
  }

  private _channelPriority(candidate: unknown): number {
    const record =
      candidate && typeof candidate === "object"
        ? (candidate as { associationChannel?: unknown; channel?: unknown })
        : {};
    const channel = record.associationChannel ?? record.channel;
    if (channel === "tag") return 0;
    if (channel === "vector") return 1;
    return 2;
  }

  private _positiveInteger(
    value: unknown,
    fallback: number,
    allowZero = false,
  ): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(allowZero ? 0 : 1, Math.round(numeric));
  }

  private _number(value: unknown, fallback: number): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  private _score(value: unknown): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  private _dimension(config: MemoryConfigOverrides, vector: unknown): number {
    const configured = Number(config.dimension);
    if (Number.isSafeInteger(configured) && configured > 0) return configured;
    if (vector instanceof Float32Array) return vector.length;
    if (vector && typeof vector === "object") {
      const byteLength = Number((vector as { byteLength?: unknown }).byteLength);
      if (Number.isSafeInteger(byteLength) && byteLength > 0) {
        return byteLength / Float32Array.BYTES_PER_ELEMENT;
      }
      const length = Number((vector as { length?: unknown }).length);
      if (Number.isSafeInteger(length) && length > 0) return length;
    }
    return 3072;
  }

  private _compareChunkIds(left: unknown, right: unknown): number {
    const a = Number(left);
    const b = Number(right);
    if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
    if (Number.isFinite(a)) return -1;
    if (Number.isFinite(b)) return 1;
    return 0;
  }
}

export default AssociatorStage;
