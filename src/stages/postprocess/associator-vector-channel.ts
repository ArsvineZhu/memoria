import type { MemoryConfigOverrides } from "../../types/config.js";
import type { ChunkCandidate } from "../../types/documents.js";
import type { PipelineContextLike } from "../../types/pipeline.js";
import { asMemoriaError } from "../../errors.js";
import { decodeVectorBlob } from "../../utils/vector-codec.js";
import { chunkInScope, number, positiveInteger } from "./associator-scope.js";
import { mergeProposal, score } from "./associator-ranking.js";
import type { AssociationChannelContext } from "./associator-types.js";

const TAG_INDEX_NAME = "tag_vectors";
const DEFAULT_VECTOR_K = 5;
const DEFAULT_VECTOR_BOOST = 0.3;

export function canUseVectorChannel(
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

export async function collectVectorProposals(
  seed: ChunkCandidate,
  context: AssociationChannelContext,
  config: MemoryConfigOverrides,
): Promise<void> {
  const { scope, allowedChunkIds, ctx, proposals, presentIds, stats } = context;
  const store = ctx.metadataStore;
  const vectorStore = ctx.vectorStore!;
  const seedChunkId = Number(seed.chunkId);
  if (!Number.isFinite(seedChunkId)) {
    stats.skipped += 1;
    return;
  }

  let vector = candidateVector(seed, config);
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
    const dimension = vectorDimension(config, row?.vector);
    vector = row?.vector
      ? decodeVectorBlob(row.vector, dimension, `chunk:${seedChunkId}`)
      : null;
  }
  if (!vector) {
    stats.skipped += 1;
    return;
  }

  const vectorK = positiveInteger(config.associatorVecK, DEFAULT_VECTOR_K);
  const hitsById = new Map<number, number>();
  for (const indexName of scope!) {
    if (indexName === TAG_INDEX_NAME) continue;
    let hits;
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
      const hitScore = score(hit && hit.score);
      if (!Number.isFinite(chunkId)) continue;
      const previous = hitsById.get(chunkId);
      if (previous === undefined || hitScore > previous)
        hitsById.set(chunkId, hitScore);
    }
  }

  const scopedHits: Array<[number, number]> = [];
  for (const [chunkId, hitScore] of hitsById) {
    if (chunkId === seedChunkId) continue;
    if (!(await chunkInScope(chunkId, scope, allowedChunkIds, ctx))) continue;
    scopedHits.push([chunkId, hitScore]);
  }
  const topHits = scopedHits
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, vectorK);
  const maxHit = Math.max(0, ...topHits.map((entry) => (entry[1] > 0 ? entry[1] : 0)));
  if (!(maxHit > 0)) return;

  const vectorBoost = number(config.associatorVecBoost, DEFAULT_VECTOR_BOOST);
  for (const [chunkId, hitScore] of topHits) {
    if (!(hitScore > 0) || presentIds.has(chunkId)) continue;
    mergeProposal(
      proposals,
      {
        chunkId,
        score: score(seed.score) * vectorBoost * (hitScore / maxHit),
        channel: "vector",
        seedChunkId,
      },
      presentIds,
    );
  }
}

function candidateVector(
  seed: ChunkCandidate,
  config: MemoryConfigOverrides,
): Float32Array | null {
  const raw = seed.vector;
  const dimension = vectorDimension(config, raw);
  if (raw instanceof Float32Array) return raw.length === dimension ? raw : null;
  if (Array.isArray(raw)) {
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

function vectorDimension(config: MemoryConfigOverrides, vector: unknown): number {
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
