import type { MetadataStoreContract } from "../types/metadata.js";

/**
 * Read the authority generation through the strongest available contract.
 * `null` means the provider cannot prove a generation and callers must not
 * use the value as a cache key or snapshot invariant.
 */
export async function readMetadataGeneration(
  store: Pick<MetadataStoreContract, "getGenerationState" | "getKv"> | null | undefined,
): Promise<string | null> {
  if (typeof store?.getGenerationState === "function") {
    try {
      const state = await store.getGenerationState();
      if (Number.isFinite(state.metadataGeneration)) {
        return String(state.metadataGeneration);
      }
    } catch {
      // Fall through to the weaker optional key-value contract.
    }
  }

  if (typeof store?.getKv === "function") {
    try {
      const value = await store.getKv("metadata_generation");
      if (typeof value === "string" && value.length > 0) return value;
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    } catch {
      // An unavailable generation is represented by null, not a cache hit.
    }
  }

  return null;
}
