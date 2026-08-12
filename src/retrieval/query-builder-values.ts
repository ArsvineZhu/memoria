import type { RetrievalPlanInput as CanonicalRetrievalPlanInput } from "./retrieval-plan.js";

export type RetrievalPlanInput = CanonicalRetrievalPlanInput;
export type RetrievalStrategy = NonNullable<RetrievalPlanInput["strategy"]>;
export type RetrievalFilterInput = NonNullable<RetrievalPlanInput["filters"]>;
export type ExpansionInput = NonNullable<RetrievalPlanInput["expansion"]>;
export type PostprocessInput = NonNullable<RetrievalPlanInput["postprocess"]>;
export type ExternalRerankInput = NonNullable<RetrievalPlanInput["externalRerank"]>;

export function mergeSection<T extends object>(
  left: T | undefined,
  right: Partial<T> | undefined,
): T | undefined {
  if (left === undefined && right === undefined) return undefined;
  return { ...(left || {}), ...(right || {}) } as T;
}

export function mergeFilters(
  left: RetrievalFilterInput | undefined,
  right: RetrievalFilterInput | undefined,
): RetrievalFilterInput | undefined {
  if (left === undefined && right === undefined) return undefined;
  return {
    ...(left || {}),
    ...(right || {}),
    ...(right?.spaces !== undefined
      ? { spaces: [...right.spaces] }
      : left?.spaces !== undefined
        ? { spaces: [...left.spaces] }
        : {}),
    ...(right?.documentIds !== undefined
      ? { documentIds: [...right.documentIds] }
      : left?.documentIds !== undefined
        ? { documentIds: [...left.documentIds] }
        : {}),
    ...(right?.metadata !== undefined
      ? { metadata: { ...right.metadata } }
      : left?.metadata !== undefined
        ? { metadata: { ...left.metadata } }
        : {}),
  };
}

export function mergePlanInputs(
  left: RetrievalPlanInput,
  right: RetrievalPlanInput,
): RetrievalPlanInput {
  return {
    ...left,
    ...right,
    associative: mergeSection(left.associative, right.associative),
    structural: mergeSection(left.structural, right.structural),
    propagationHistory: mergeSection(left.propagationHistory, right.propagationHistory),
    filters: mergeFilters(left.filters, right.filters),
    externalRerank: mergeSection(left.externalRerank, right.externalRerank),
    expansion: mergeSection(left.expansion, right.expansion),
    postprocess: mergeSection(left.postprocess, right.postprocess),
  };
}

export function hasPlanInput(input: RetrievalPlanInput): boolean {
  return Object.values(input).some((value) => value !== undefined);
}
