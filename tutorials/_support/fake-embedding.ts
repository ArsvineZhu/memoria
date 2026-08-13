import type { EmbeddingProviderContract, VectorLike } from "@arsvinezhu/memoria";

function hash(value: string): number {
  let result = 2166136261;
  for (const character of value) {
    result ^= character.codePointAt(0) ?? 0;
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

/** Deterministic tutorial provider. It guarantees shape and lifecycle, not relevance quality. */
export class FakeEmbeddingProvider implements EmbeddingProviderContract {
  constructor(private readonly dimension = 128) {
    if (!Number.isSafeInteger(dimension) || dimension <= 0) {
      throw new Error("Fake embedding dimension must be a positive integer");
    }
  }

  getDimension(): number {
    return this.dimension;
  }

  embed(text: string): VectorLike {
    const vector = new Float32Array(this.dimension);
    for (let index = 0; index < text.length; index += 1) {
      const code = hash(`${text[index] ?? ""}:${index}`) % this.dimension;
      vector[code] = (vector[code] ?? 0) + 1;
    }
    let norm = 0;
    for (const value of vector) norm += value * value;
    const scale = norm === 0 ? 1 : 1 / Math.sqrt(norm);
    for (let index = 0; index < vector.length; index += 1)
      vector[index] = (vector[index] ?? 0) * scale;
    return vector;
  }

  async embedBatch(texts: readonly string[] = []): Promise<(VectorLike | null)[]> {
    return texts.map((text) => this.embed(text));
  }
}
