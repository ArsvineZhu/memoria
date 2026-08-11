import type { PipelineContextLike, PipelineData } from "../../types.js";

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

function normalizeContentNames(value: unknown, tagIndexName: unknown): string[] {
  const names = normalizeNames(value);
  const tagName =
    (typeof tagIndexName === "string" ? tagIndexName : "global_tags").trim() ||
    "global_tags";
  return names.filter((name) => name !== tagName && name !== "global_tags");
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
      info.diaryNames,
      info.diaryName,
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
          resolvedIndexNames: normalizeContentNames(names, config.tagIndexName),
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

    if (metadataStore && typeof metadataStore.getDistinctDiaryNames === "function") {
      try {
        const names = await metadataStore.getDistinctDiaryNames();
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
    diaryNames: unknown,
    diaryName: unknown,
    libraries: unknown,
  ): string[] | null {
    if (Array.isArray(inputIndexNames)) return normalizeNames(inputIndexNames);
    if (Array.isArray(diaryNames)) return normalizeNames(diaryNames);
    if (typeof diaryName === "string") return normalizeNames([diaryName]);
    if (Array.isArray(libraries)) return normalizeNames(libraries);
    return null;
  }
}

export { normalizeNames };
export default SearchScopeResolverStage;
