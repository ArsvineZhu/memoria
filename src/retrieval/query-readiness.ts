import type { PipelineContextLike } from "../types/pipeline.js";
import type { GraphReadiness } from "./query-planner-types.js";

export function defaultGraphReadiness(): GraphReadiness {
  return {
    explicitLinks: 0,
    activeInferredLinks: 0,
    candidatePathCount: 0,
    tagGraphArtifactReady: true,
    permissionScopeReady: true,
  };
}

export function mergeGraphReadiness(
  input: Partial<GraphReadiness> | undefined,
): GraphReadiness {
  return { ...defaultGraphReadiness(), ...(input || {}) };
}

/** Read durable graph/native readiness without executing a query or MDX. */
export async function readGraphReadiness(
  ctx: Pick<
    PipelineContextLike,
    "metadataStore" | "config" | "tagRetrievalRuntime" | "vectorStore"
  >,
): Promise<GraphReadiness> {
  let explicitLinks = 0;
  let activeInferredLinks = 0;
  if (typeof ctx.metadataStore?.getRelationReadinessStats === "function") {
    try {
      const stats = await ctx.metadataStore.getRelationReadinessStats();
      explicitLinks = Number(stats.explicitLinks) || 0;
      activeInferredLinks = Number(stats.activeInferredLinks) || 0;
    } catch {
      // Relation readiness is auxiliary to semantic/vector retrieval.
    }
  } else if (typeof ctx.metadataStore?.listRelations === "function") {
    try {
      const relations = await ctx.metadataStore.listRelations();
      for (const relation of relations) {
        if (relation.origin === "source") explicitLinks += 1;
        else activeInferredLinks += 1;
      }
    } catch {
      // Providers may fail graph reads without taking down ordinary search.
    }
  }
  const explicitIndex = ctx.tagRetrievalRuntime as Record<string, unknown> | undefined;
  const vectorIndices = (ctx.vectorStore as { indices?: unknown } | null | undefined)
    ?.indices;
  const ownedIndex =
    explicitIndex ||
    (vectorIndices instanceof Map
      ? (vectorIndices.get(String(ctx.config.tagVectorIndexName || "tag_vectors")) as
          Record<string, unknown> | undefined)
      : undefined);
  const dbPath = typeof ctx.config.dbPath === "string" ? ctx.config.dbPath : "";
  const tagGraphArtifactReady =
    !ownedIndex ||
    (typeof ownedIndex.rebuildTagGraphArtifact === "function" &&
      dbPath.length > 0 &&
      dbPath !== ":memory:" &&
      !dbPath.startsWith("file::memory:"));
  return {
    explicitLinks,
    activeInferredLinks,
    candidatePathCount: explicitLinks + activeInferredLinks > 0 ? 1 : 0,
    tagGraphArtifactReady,
    permissionScopeReady: true,
  };
}
