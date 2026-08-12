import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";

function normalizeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const name = String(item ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function normalizeContentNames(value: unknown, tagVectorIndexName: unknown): string[] {
  const names = normalizeNames(value);
  const tagName =
    (typeof tagVectorIndexName === "string"
      ? tagVectorIndexName
      : "tag_vectors"
    ).trim() || "tag_vectors";
  return names.filter((name) => name !== tagName && name !== "tag_vectors");
}

/** Resolve the authoritative content scope once for all retrieval stages. */
class SearchScopeResolverStage extends Stage {
  constructor() {
    super();
    this.name = "searchScopeResolver";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "resolvedIndexNames"> & { resolvedIndexNames: string[] }
  > {
    const info = input || {};
    const config = ctx.config || {};
    const callExplicit = this._firstExplicit(
      info.indexNames,
      info.spaces,
      info.space,
      info.libraries,
    );
    if (callExplicit !== null) {
      return {
        ...info,
        resolvedIndexNames: callExplicit,
        scopeSource: "call",
        scopeWasExplicit: true,
      };
    }

    if (Array.isArray(config.indexNames)) {
      return {
        ...info,
        resolvedIndexNames: normalizeNames(config.indexNames),
        scopeSource: "config",
        scopeWasExplicit: true,
      };
    }

    const metadataStore = ctx.metadataStore;
    if (
      metadataStore &&
      typeof metadataStore.getExpectedVectorIndexNames === "function"
    ) {
      try {
        const names = await metadataStore.getExpectedVectorIndexNames();
        return {
          ...info,
          resolvedIndexNames: normalizeContentNames(names, config.tagVectorIndexName),
          scopeSource: "authority",
          scopeWasExplicit: false,
        };
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Metadata store failed while discovering search scope.",
          { retryable: true },
        );
      }
    }

    if (metadataStore && typeof metadataStore.getDistinctSpaces === "function") {
      try {
        const names = await metadataStore.getDistinctSpaces();
        return {
          ...info,
          resolvedIndexNames: normalizeNames(names),
          scopeSource: "authority",
          scopeWasExplicit: false,
        };
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Metadata store failed while discovering search scope.",
          { retryable: true },
        );
      }
    }

    return {
      ...info,
      resolvedIndexNames: ["Root"],
      scopeSource: "fallback",
      scopeWasExplicit: false,
    };
  }

  private _firstExplicit(
    inputIndexNames: unknown,
    spaces: unknown,
    space: unknown,
    libraries: unknown,
  ): string[] | null {
    if (Array.isArray(inputIndexNames)) return normalizeNames(inputIndexNames);
    if (Array.isArray(spaces)) return normalizeNames(spaces);
    if (typeof space === "string") return normalizeNames([space]);
    if (Array.isArray(libraries)) return normalizeNames(libraries);
    return null;
  }
}

export { normalizeNames };
export default SearchScopeResolverStage;
