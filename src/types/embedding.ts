import type { EmbeddingVector } from "./common.js";

export interface EmbeddingProviderContract {
  embedBatch(
    texts?: readonly string[],
    options?: EmbeddingOptions,
  ): Promise<(EmbeddingVector | null)[]>;
  embed?(
    text: string,
    options?: EmbeddingOptions,
  ): EmbeddingVector | Promise<EmbeddingVector | null>;
  getDimension(): number;
}

export interface EmbeddingOptions {
  textType?: string;
  [key: string]: unknown;
}

export type EmbeddingProvider = EmbeddingProviderContract;
