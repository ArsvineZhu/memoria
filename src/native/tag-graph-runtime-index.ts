import type { PipelineContextLike } from "../types/pipeline.js";
import {
  createTagRetrievalRuntimeFacade,
  type TagRetrievalRuntimeIndex,
} from "./tag-retrieval-runtime.js";
import type { TagRetrievalIndex } from "./tag-graph-runtime-types.js";
import { isRecord } from "./tag-graph-runtime-serialization.js";

export function clearTagRetrievalRuntime(index: object): void {
  const runtimeIndex = index as TagRetrievalRuntimeIndex;
  if (typeof runtimeIndex.clearTagRetrievalRuntime === "function") {
    runtimeIndex.clearTagRetrievalRuntime.call(runtimeIndex);
  }
}

export function asTagRetrievalIndex(value: unknown): TagRetrievalIndex | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.rebuildTagGraphArtifact !== "function" &&
    typeof value.runTagRetrievalPipeline !== "function" &&
    typeof value.rerankByPropagationStructure !== "function" &&
    typeof value.rerankByPropagationSupport !== "function"
  ) {
    return null;
  }
  return value as TagRetrievalIndex;
}

export function getTagRetrievalIndex(
  ctx: PipelineContextLike,
  indexName = String(ctx.config.tagVectorIndexName || "tag_vectors"),
): TagRetrievalIndex | null {
  const explicit = asTagRetrievalIndex(ctx.tagRetrievalRuntime);
  if (explicit) return explicit;
  const vectorStore = ctx.vectorStore as { indices?: unknown } | null | undefined;
  if (vectorStore?.indices instanceof Map) {
    return asTagRetrievalIndex(vectorStore.indices.get(indexName));
  }
  return null;
}

export function createRuntimeFacade(index: TagRetrievalIndex, dbPath: string) {
  return createTagRetrievalRuntimeFacade(index, dbPath);
}
