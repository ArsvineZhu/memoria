import type { EmbeddingVector, UnknownRecord } from "../../types/common.js";
import type {
  PropagationTrace,
  TagBasisProjectionEnvelope,
  TagGraphPropagationData,
  TagResidualDecompositionData,
} from "../../types/retrieval.js";
import type { PipelineData } from "../../types/pipeline.js";

/**
 * One internal hand-off for all tag retrieval mathematics.
 *
 * Native Rust and the TypeScript fallback populate the same shape. The raw
 * stage payload remains private and is never used as a second source of truth
 * by support, structure, or history stages.
 */
export interface TagRetrievalObservation {
  readonly source: "native" | "typescript";
  readonly basis?: TagBasisProjectionEnvelope;
  readonly residual?: TagResidualDecompositionData;
  readonly propagation?: TagGraphPropagationData;
  readonly enhancedVector?: EmbeddingVector;
  readonly localVector?: EmbeddingVector;
  readonly extendedVector?: EmbeddingVector;
  readonly localDistribution?: ReadonlyArray<readonly [number, number]>;
  readonly extendedDistribution?: ReadonlyArray<readonly [number, number]>;
  readonly localSupportIds?: readonly number[];
  readonly extendedSupportIds?: readonly number[];
  readonly observationHandle?: string;
  readonly nativeObservation?: UnknownRecord;
  readonly diagnostics?: UnknownRecord;
}

export function mergeTagRetrievalObservation(
  input: PipelineData,
  patch: Omit<Partial<TagRetrievalObservation>, "source"> & {
    source?: TagRetrievalObservation["source"];
  },
): TagRetrievalObservation {
  const current = input.tagRetrievalObservation;
  return {
    ...(current || { source: patch.source || "typescript" }),
    ...patch,
    source: patch.source || current?.source || "typescript",
  };
}

export function propagationTraceFromObservation(
  observation: TagRetrievalObservation | undefined,
): PropagationTrace | undefined {
  return observation?.propagation?.propagationTrace;
}
