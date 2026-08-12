import type { MemoryConfigOverrides } from "../../types/config.js";
import type { ChunkCandidate } from "../../types/documents.js";
import type { PipelineContextLike } from "../../types/pipeline.js";
import type { AssociationChannelContext } from "./associator-types.js";
import { asMemoriaError } from "../../errors.js";
import { chunkInScope, number } from "./associator-scope.js";
import { mergeProposal, score } from "./associator-ranking.js";

const DEFAULT_TAG_BOOST = 0.45;

export function canUseTagChannel(store: PipelineContextLike["metadataStore"]): boolean {
  return !!(
    store &&
    typeof store.buildCooccurrenceMatrix === "function" &&
    typeof store.getFileByChunkId === "function" &&
    typeof store.getFileTags === "function" &&
    typeof store.getFileIdsByTagId === "function" &&
    typeof store.getChunksByFileId === "function"
  );
}

export async function collectTagProposals(
  seed: ChunkCandidate,
  matrix: Map<number, Map<number, number>>,
  context: AssociationChannelContext,
  config: MemoryConfigOverrides,
): Promise<void> {
  const { scope, allowedChunkIds, ctx, proposals, presentIds, stats } = context;
  const store = ctx.metadataStore!;
  const seedChunkId = Number(seed.chunkId);
  if (!Number.isFinite(seedChunkId)) {
    stats.skipped += 1;
    return;
  }

  let seedFile;
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
  const tagIds = await resolveTagIds(fileTags, store);
  const neighborWeights = new Map<number, number>();
  for (const tagId of tagIds) {
    const neighbors = matrix.get(tagId);
    if (!(neighbors instanceof Map)) continue;
    for (const [neighborId, rawWeight] of neighbors) {
      const weight = Number(rawWeight);
      if (!Number.isFinite(weight) || weight <= 0 || neighborId === tagId) continue;
      neighborWeights.set(neighborId, (neighborWeights.get(neighborId) || 0) + weight);
    }
  }
  const orderedNeighbors = [...neighborWeights.entries()].sort(
    (left, right) => right[1] - left[1] || left[0] - right[0],
  );
  const maxWeight = orderedNeighbors[0]?.[1] ?? 0;
  if (!(maxWeight > 0)) return;

  const tagBoost = number(config.associatorTagBoost, DEFAULT_TAG_BOOST);
  const seedScore = score(seed.score);
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
        if (!(await chunkInScope(chunkId, scope, allowedChunkIds, ctx))) continue;
        mergeProposal(
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

async function resolveTagIds(
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
