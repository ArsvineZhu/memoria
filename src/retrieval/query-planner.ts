/** Stable query-planner facade; profile, strategy, and readiness are separate kernels. */
export type {
  GraphReadiness,
  QueryInterpreter,
  QueryPlanningOptions,
  QueryProfile,
  QueryProfileSignals,
  RetrievalDecision,
  RetrievalExplanation,
  RetrievalStrategySource,
  StrategyDecision,
} from "./query-planner-types.js";
export { profileNaturalLanguageQuery } from "./query-profile.js";
export { readGraphReadiness } from "./query-readiness.js";
export { chooseStrategy } from "./query-strategy.js";

import { profileNaturalLanguageQuery } from "./query-profile.js";
import { planFromProfile } from "./query-strategy.js";
import type { QueryPlanningOptions, RetrievalDecision } from "./query-planner-types.js";

export function planRetrieval(
  query: string,
  options: QueryPlanningOptions = {},
): RetrievalDecision {
  return planFromProfile(profileNaturalLanguageQuery(query, options.hints), options);
}

/** Async variant used when an application supplies a richer interpreter. */
export async function planRetrievalAsync(
  query: string,
  options: QueryPlanningOptions = {},
): Promise<RetrievalDecision> {
  const interpreted = options.interpreter
    ? await options.interpreter.interpret(query)
    : {};
  return planFromProfile(
    profileNaturalLanguageQuery(query, {
      ...(options.hints || {}),
      ...(interpreted || {}),
    }),
    options,
  );
}
