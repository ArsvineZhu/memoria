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
    const explicit = this._firstExplicit(
      info.indexNames,
      config.indexNames,
      info.diaryNames,
      info.diaryName,
      info.libraries,
    );
    if (explicit !== null) return { ...info, resolvedIndexNames: explicit };

    const metadataStore = ctx.metadataStore;
    if (
      metadataStore &&
      typeof metadataStore.getExpectedVectorIndexNames === "function"
    ) {
      try {
        const names = await metadataStore.getExpectedVectorIndexNames();
        return { ...info, resolvedIndexNames: normalizeNames(names) };
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
        return { ...info, resolvedIndexNames: normalizeNames(names) };
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Metadata store failed while discovering search scope.",
          { retryable: true },
        );
      }
    }

    return { ...info, resolvedIndexNames: ["Root"] };
  }

  private _firstExplicit(
    inputIndexNames: unknown,
    configIndexNames: unknown,
    diaryNames: unknown,
    diaryName: unknown,
    libraries: unknown,
  ): string[] | null {
    if (Array.isArray(inputIndexNames)) return normalizeNames(inputIndexNames);
    if (Array.isArray(configIndexNames)) return normalizeNames(configIndexNames);
    if (Array.isArray(diaryNames)) return normalizeNames(diaryNames);
    if (typeof diaryName === "string") return normalizeNames([diaryName]);
    if (Array.isArray(libraries)) return normalizeNames(libraries);
    return null;
  }
}

export { normalizeNames };
export default SearchScopeResolverStage;
