import type { RecallCase } from "./recall-cases.js";

export interface RecallMetrics {
  totalQueries: number;
  recallAt: Record<1 | 3 | 5, number>;
  mrr: number;
  firstRelevantRanks: Record<string, number | null>;
}

export type QueryEmbeddingBatch = (
  texts: readonly string[],
  textType: string,
) => Promise<readonly (Float32Array | null)[]>;

/**
 * Convert an output path into the stable path used by the recall corpus qrels.
 * Absolute paths, Windows separators, and a leading `recall-demo/` segment are
 * accepted so the metrics can consume raw engine results without changing them.
 */
export function normalizeRecallPath(value: string): string {
  let normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/\\/g, "/")
    .trim();

  while (normalized.startsWith("./")) normalized = normalized.slice(2);

  const lower = normalized.toLowerCase();
  const markers = ["data/content/recall-demo/", "recall-demo/"];
  for (const marker of markers) {
    const markerIndex = lower.lastIndexOf(marker);
    if (markerIndex >= 0) {
      return normalized.slice(markerIndex + marker.length).replace(/^\/+/, "").toLowerCase();
    }
  }

  return normalized.replace(/^\/+/, "").toLowerCase();
}

export function evaluateRecall(
  cases: readonly RecallCase[],
  resultsByCase: ReadonlyMap<string, readonly string[]>,
): RecallMetrics {
  const hitsAt = { 1: 0, 3: 0, 5: 0 };
  const firstRelevantRanks: Record<string, number | null> = {};
  let reciprocalRankTotal = 0;

  for (const recallCase of cases) {
    const relevant = new Set(
      recallCase.relevantPaths.map((relativePath) => normalizeRecallPath(relativePath)),
    );
    const candidates = resultsByCase.get(recallCase.id) ?? [];
    let firstRelevantRank: number | null = null;

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate !== undefined && relevant.has(normalizeRecallPath(candidate))) {
        firstRelevantRank = index + 1;
        break;
      }
    }

    firstRelevantRanks[recallCase.id] = firstRelevantRank;
    if (firstRelevantRank !== null) {
      reciprocalRankTotal += 1 / firstRelevantRank;
      if (firstRelevantRank <= 1) hitsAt[1] += 1;
      if (firstRelevantRank <= 3) hitsAt[3] += 1;
      if (firstRelevantRank <= 5) hitsAt[5] += 1;
    }
  }

  const totalQueries = cases.length;
  const denominator = totalQueries > 0 ? totalQueries : 1;

  return {
    totalQueries,
    recallAt: {
      1: hitsAt[1] / denominator,
      3: hitsAt[3] / denominator,
      5: hitsAt[5] / denominator,
    },
    mrr: reciprocalRankTotal / denominator,
    firstRelevantRanks,
  };
}

function cloneEmbeddings(
  embeddings: readonly (Float32Array | null)[],
): (Float32Array | null)[] {
  return embeddings.map((embedding) =>
    embedding === null ? null : new Float32Array(embedding),
  );
}

/**
 * Query-only embedding cache used by the demo's baseline/enhanced comparisons.
 * The key includes both the provider text type and the ordered input list.
 */
export class QueryEmbeddingCache {
  private readonly cache = new Map<string, readonly (Float32Array | null)[]>();

  private readonly inFlight = new Map<
    string,
    Promise<readonly (Float32Array | null)[]>
  >();

  constructor(private readonly embedder: QueryEmbeddingBatch) {}

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  async embedBatch(
    texts: readonly string[],
    textType = "query",
  ): Promise<(Float32Array | null)[]> {
    const normalizedTexts = texts.map((text) => String(text));
    const key = JSON.stringify([String(textType), normalizedTexts]);
    const cached = this.cache.get(key);
    if (cached) return cloneEmbeddings(cached);

    const existing = this.inFlight.get(key);
    if (existing) return cloneEmbeddings(await existing);

    const pending = Promise.resolve()
      .then(() => this.embedder(normalizedTexts, String(textType)))
      .then((embeddings) => {
        if (!Array.isArray(embeddings) || embeddings.length !== normalizedTexts.length) {
          throw new Error(
            `Query embedding provider returned ${embeddings?.length ?? 0} vectors for ${normalizedTexts.length} texts`,
          );
        }

        const stored = embeddings.map((embedding) =>
          embedding === null ? null : new Float32Array(embedding),
        );
        this.cache.set(key, stored);
        return stored;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, pending);
    return cloneEmbeddings(await pending);
  }
}
