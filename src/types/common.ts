/** A vector accepted at the public boundary before it is normalised. */
export type VectorLike = Float32Array | readonly number[];
export type Vector = Float32Array;
export type EmbeddingVector = VectorLike;

export type UnknownRecord = Record<string, unknown>;

export interface SourcePriority {
  semantic?: number;
  time?: number;
  bm25Body?: number;
  bm25Tag?: number;
  continuity?: number;
  associate?: number;
  unknown?: number;
}

export type QueryRephraser = (query: string, index: number) => string | Promise<string>;

export type ExternalReranker = (
  query: string,
  results: readonly import("./documents.js").ChunkCandidate[],
) =>
  | readonly import("./documents.js").ChunkCandidate[]
  | Promise<readonly import("./documents.js").ChunkCandidate[]>;

export type Tokenizer = (
  text: string,
) => readonly string[] | Promise<readonly string[]>;
