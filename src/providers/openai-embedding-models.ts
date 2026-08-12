export interface EmbeddingModelChain {
  primary: string;
  fallbacks: string[];
}

export function normalizeFallbackModels(
  fallbackModels: readonly string[] | string | undefined,
): string[] {
  if (Array.isArray(fallbackModels)) return [...fallbackModels];
  if (!fallbackModels) return [];
  return String(fallbackModels)
    .split(/[,，]/)
    .map((model) => model.trim())
    .filter(Boolean);
}

export function uniqueModelCandidates(chain: EmbeddingModelChain): string[] {
  const candidates: string[] = [];
  const addModel = (model: unknown): void => {
    const normalized = typeof model === "string" ? model.trim() : "";
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };

  addModel(chain.primary);
  chain.fallbacks.forEach(addModel);
  return candidates;
}
