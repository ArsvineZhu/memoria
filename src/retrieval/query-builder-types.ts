import type { MemoryEngine } from "../engine.js";
import type { SearchOptions } from "../types/config.js";
import type {
  ExternalRerankInput,
  ExpansionInput,
  PostprocessInput,
  RetrievalPlanInput,
  RetrievalStrategy,
} from "./query-builder-values.js";

export type CoreStrategy = Exclude<RetrievalStrategy, "auto"> | "auto";
export type QueryRunOptions = Omit<
  SearchOptions,
  "retrievalPlan" | "inheritRetrievalDefaults"
>;
export type GroupCallback<T> = (builder: T) => T;

export interface QueryBuilderState {
  engine: MemoryEngine;
  queryText: string;
  override: RetrievalPlanInput;
  inheritDefaults: boolean;
  coreSelections: readonly CoreStrategy[];
}

export type {
  ExternalRerankInput,
  ExpansionInput,
  PostprocessInput,
  RetrievalPlanInput,
};

export type RetrievalFilterInput = NonNullable<RetrievalPlanInput["filters"]>;
