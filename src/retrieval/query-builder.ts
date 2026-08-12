"use strict";

import type { MemoryEngine } from "../engine.js";
import type { SearchEnvelope, SearchOptions } from "../types.js";
import {
  assertValidRetrievalPlanInput,
  mergeRetrievalPlan,
  normalizeRetrievalPlan,
  type RetrievalPlan,
  type RetrievalPlanInput,
  type RetrievalStrategy,
} from "./retrieval-plan.js";

export type RetrievalFilterInput = NonNullable<RetrievalPlanInput["filters"]>;
export type ExpansionInput = NonNullable<RetrievalPlanInput["expansion"]>;
export type PostprocessInput = NonNullable<RetrievalPlanInput["postprocess"]>;
export type ExternalRerankInput = NonNullable<RetrievalPlanInput["externalRerank"]>;

type CoreStrategy = Exclude<RetrievalStrategy, "auto"> | "auto";

function mergeSection<T extends object>(
  left: T | undefined,
  right: Partial<T> | undefined,
): T | undefined {
  if (left === undefined && right === undefined) return undefined;
  return { ...(left || {}), ...(right || {}) } as T;
}

function mergeFilters(
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

function mergePlanInputs(
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

function hasPlanInput(input: RetrievalPlanInput): boolean {
  return Object.values(input).some((value) => value !== undefined);
}

function appendUnique(values: readonly string[] | undefined, value: string): string[] {
  return [...new Set([...(values || []), value])];
}

export class ScopeBuilder {
  private readonly value: RetrievalFilterInput;

  constructor(value: RetrievalFilterInput = {}) {
    this.value = {
      ...value,
      ...(value.spaces ? { spaces: [...value.spaces] } : {}),
      ...(value.documentIds ? { documentIds: [...value.documentIds] } : {}),
      ...(value.metadata ? { metadata: { ...value.metadata } } : {}),
    };
  }

  space(name: string): ScopeBuilder {
    return new ScopeBuilder({
      ...this.value,
      spaces: appendUnique(this.value.spaces, String(name)),
    });
  }

  spaces(names: readonly string[]): ScopeBuilder {
    return new ScopeBuilder({ ...this.value, spaces: names.map(String) });
  }

  document(id: string): ScopeBuilder {
    return new ScopeBuilder({
      ...this.value,
      documentIds: appendUnique(this.value.documentIds, String(id)),
    });
  }

  documents(ids: readonly string[]): ScopeBuilder {
    return new ScopeBuilder({ ...this.value, documentIds: ids.map(String) });
  }

  recordedAfter(value: number | string): ScopeBuilder {
    return new ScopeBuilder({ ...this.value, recordedAfter: value });
  }

  recordedBefore(value: number | string): ScopeBuilder {
    return new ScopeBuilder({ ...this.value, recordedBefore: value });
  }

  metadata(value: Record<string, unknown>): ScopeBuilder {
    return new ScopeBuilder({ ...this.value, metadata: { ...value } });
  }

  build(): RetrievalFilterInput {
    return new ScopeBuilder(this.value).value;
  }
}

export class ExpansionBuilder {
  private readonly value: ExpansionInput;

  constructor(value: ExpansionInput = {}) {
    this.value = { ...value };
  }

  related(
    options: Pick<ExpansionInput, "maxHops" | "maxAdded"> = {},
  ): ExpansionBuilder {
    return new ExpansionBuilder({ ...this.value, ...options, related: true });
  }

  sameDocument(enabled = true): ExpansionBuilder {
    return new ExpansionBuilder({ ...this.value, sameDocument: enabled });
  }

  fullDocument(enabled = true): ExpansionBuilder {
    return new ExpansionBuilder({ ...this.value, fullDocument: enabled });
  }

  associate(enabled = true): ExpansionBuilder {
    return new ExpansionBuilder({ ...this.value, associate: enabled });
  }

  maxHops(value: number): ExpansionBuilder {
    return new ExpansionBuilder({ ...this.value, maxHops: value });
  }

  maxAdded(value: number): ExpansionBuilder {
    return new ExpansionBuilder({ ...this.value, maxAdded: value });
  }

  build(): ExpansionInput {
    return { ...this.value };
  }
}

export class PostprocessBuilder {
  private readonly value: PostprocessInput;

  constructor(value: PostprocessInput = {}) {
    this.value = { ...value };
  }

  timeDecay(enabled = true): PostprocessBuilder {
    return new PostprocessBuilder({ ...this.value, timeDecay: enabled });
  }

  dedupe(enabled = true): PostprocessBuilder {
    return new PostprocessBuilder({ ...this.value, dedupe: enabled });
  }

  truncate(enabled = true): PostprocessBuilder {
    return new PostprocessBuilder({ ...this.value, truncate: enabled });
  }

  minScore(value: number): PostprocessBuilder {
    return new PostprocessBuilder({ ...this.value, minScore: value });
  }

  limit(value: number): PostprocessBuilder {
    return new PostprocessBuilder({ ...this.value, maxResults: value });
  }

  maxContentLength(value: number): PostprocessBuilder {
    return new PostprocessBuilder({ ...this.value, maxContentLength: value });
  }

  build(): PostprocessInput {
    return { ...this.value };
  }
}

export class RerankBuilder {
  private readonly value: ExternalRerankInput;

  constructor(value: ExternalRerankInput = {}) {
    this.value = { ...value };
  }

  ordered(): RerankBuilder {
    return new RerankBuilder({ ...this.value, enabled: true, mode: "ordered" });
  }

  rrf(options: Pick<ExternalRerankInput, "alpha"> = {}): RerankBuilder {
    return new RerankBuilder({
      ...this.value,
      ...options,
      enabled: true,
      mode: "rrf",
    });
  }

  build(): ExternalRerankInput {
    return { ...this.value };
  }
}

type GroupCallback<T> = (builder: T) => T;
type QueryRunOptions = Omit<
  SearchOptions,
  "retrievalPlan" | "inheritRetrievalDefaults"
>;

function requireGroupBuilder<T extends { build(): object }>(value: T, name: string): T {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.build !== "function"
  ) {
    throw new TypeError(`${name} callback must return its group builder`);
  }
  return value;
}

function requireGroupInput<T>(value: T, name: string): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} input must be an object or callback`);
  }
  return value;
}

/** Immutable fluent syntax over the canonical RetrievalPlan input. */
export class QueryBuilder {
  private readonly engine: MemoryEngine;
  private readonly queryText: string;
  private readonly override: RetrievalPlanInput;
  private readonly inheritDefaults: boolean;
  private readonly coreSelections: readonly CoreStrategy[];

  constructor(
    engine: MemoryEngine,
    query: string,
    override: RetrievalPlanInput = {},
    inheritDefaults = true,
    coreSelections: readonly CoreStrategy[] = [],
  ) {
    this.engine = engine;
    this.queryText = String(query ?? "");
    this.override = mergePlanInputs({}, override);
    this.inheritDefaults = inheritDefaults;
    this.coreSelections = [...coreSelections];
  }

  private next(
    patch: RetrievalPlanInput = {},
    options: {
      inheritDefaults?: boolean;
      core?: CoreStrategy;
    } = {},
  ): QueryBuilder {
    const coreSelections = options.core
      ? [...this.coreSelections, options.core]
      : [...this.coreSelections];
    return new QueryBuilder(
      this.engine,
      this.queryText,
      mergePlanInputs(this.override, patch),
      options.inheritDefaults ?? this.inheritDefaults,
      coreSelections,
    );
  }

  private selectCore(strategy: CoreStrategy): QueryBuilder {
    return this.next({ strategy }, { core: strategy });
  }

  using(strategy: CoreStrategy): QueryBuilder {
    return this.selectCore(strategy);
  }

  auto(): QueryBuilder {
    return this.using("auto");
  }

  semantic(): QueryBuilder {
    return this.using("semantic");
  }

  associative(): QueryBuilder {
    return this.using("associative");
  }

  structural(): QueryBuilder {
    return this.using("structural");
  }

  tagBasisProjection(enabled = true): QueryBuilder {
    return this.next(
      {
        strategy: "associative",
        associative: { enabled: true, tagBasisProjection: enabled },
      },
      { core: "associative" },
    );
  }

  tagResidualDecomposition(enabled = true): QueryBuilder {
    return this.next(
      {
        strategy: "associative",
        associative: { enabled: true, tagResidualDecomposition: enabled },
      },
      { core: "associative" },
    );
  }

  activationPropagation(enabled = true): QueryBuilder {
    return this.next(
      {
        strategy: "associative",
        associative: { enabled: true, tagGraphPropagation: enabled },
      },
      { core: "associative" },
    );
  }

  graphDiffusion(enabled = true): QueryBuilder {
    return this.next(
      {
        strategy: "associative",
        associative: { enabled: true, tagGraphPropagation: enabled },
      },
      { core: "associative" },
    );
  }

  propagationSupport(enabled = true): QueryBuilder {
    return this.next(
      {
        strategy: "associative",
        associative: { enabled: true, propagationSupport: enabled },
      },
      { core: "associative" },
    );
  }

  propagationStructure(enabled = true): QueryBuilder {
    return this.next(
      {
        strategy: "structural",
        structural: { enabled: true, propagationStructure: enabled },
      },
      { core: "structural" },
    );
  }

  propagationHistory(enabled = true): QueryBuilder {
    return this.next({ propagationHistory: { enabled } });
  }

  embeddingRerank(enabled = true): QueryBuilder {
    return this.next(
      {
        strategy: "associative",
        associative: { enabled: true, embeddingRerank: enabled },
      },
      { core: "associative" },
    );
  }

  tagExpansion(enabled = true): QueryBuilder {
    return this.next(
      {
        strategy: "associative",
        associative: { enabled: true, tagExpansion: enabled },
      },
      { core: "associative" },
    );
  }

  nativeTagRetrieval(enabled = true): QueryBuilder {
    return this.next(
      {
        strategy: "associative",
        associative: { enabled: true, nativeTagRetrieval: enabled },
      },
      { core: "associative" },
    );
  }

  structuralRelations(enabled = true): QueryBuilder {
    return this.next(
      {
        strategy: "structural",
        structural: { enabled: true, relationExpansion: enabled },
      },
      { core: "structural" },
    );
  }

  where(input: RetrievalFilterInput | GroupCallback<ScopeBuilder>): QueryBuilder {
    if (typeof input !== "function") assertValidRetrievalPlanInput({ filters: input });
    const builder =
      typeof input === "function"
        ? requireGroupBuilder(input(new ScopeBuilder()), "where")
        : new ScopeBuilder(requireGroupInput(input, "where"));
    assertValidRetrievalPlanInput({ filters: builder.build() });
    return this.next({ filters: builder.build() });
  }

  expand(input: ExpansionInput | GroupCallback<ExpansionBuilder>): QueryBuilder {
    if (typeof input !== "function")
      assertValidRetrievalPlanInput({ expansion: input });
    const builder =
      typeof input === "function"
        ? requireGroupBuilder(input(new ExpansionBuilder()), "expand")
        : new ExpansionBuilder(requireGroupInput(input, "expand"));
    assertValidRetrievalPlanInput({ expansion: builder.build() });
    return this.next({ expansion: builder.build() });
  }

  rerank(input: ExternalRerankInput | GroupCallback<RerankBuilder>): QueryBuilder {
    if (typeof input !== "function") {
      assertValidRetrievalPlanInput({ externalRerank: input });
    }
    const builder =
      typeof input === "function"
        ? requireGroupBuilder(input(new RerankBuilder()), "rerank")
        : new RerankBuilder(requireGroupInput(input, "rerank"));
    assertValidRetrievalPlanInput({ externalRerank: builder.build() });
    return this.next({ externalRerank: builder.build() });
  }

  postprocess(
    input: PostprocessInput | GroupCallback<PostprocessBuilder>,
  ): QueryBuilder {
    if (typeof input !== "function") {
      assertValidRetrievalPlanInput({ postprocess: input });
    }
    const builder =
      typeof input === "function"
        ? requireGroupBuilder(input(new PostprocessBuilder()), "postprocess")
        : new PostprocessBuilder(requireGroupInput(input, "postprocess"));
    assertValidRetrievalPlanInput({ postprocess: builder.build() });
    return this.next({ postprocess: builder.build() });
  }

  withoutDefaults(): QueryBuilder {
    return this.next({}, { inheritDefaults: false });
  }

  withDefaults(): QueryBuilder {
    return this.next({}, { inheritDefaults: true });
  }

  toPlan(): RetrievalPlan {
    this.assertNoCoreConflict();
    return normalizeRetrievalPlan(
      mergeRetrievalPlan(
        this.engine.defaultRetrievalPlan,
        this.override,
        this.inheritDefaults,
      ),
    );
  }

  async run(options: QueryRunOptions = {}): Promise<SearchEnvelope> {
    this.assertNoCoreConflict();
    const rawOptions = options as SearchOptions;
    if (
      Object.prototype.hasOwnProperty.call(rawOptions, "retrievalPlan") ||
      Object.prototype.hasOwnProperty.call(rawOptions, "inheritRetrievalDefaults")
    ) {
      throw new TypeError(
        "QueryBuilder.run() owns retrievalPlan and inheritRetrievalDefaults; configure them on the builder",
      );
    }
    const searchOptions: SearchOptions = {
      ...options,
      inheritRetrievalDefaults: this.inheritDefaults,
    };
    if (hasPlanInput(this.override)) {
      searchOptions.retrievalPlan = this.override;
    }
    return this.engine.search(this.queryText, searchOptions);
  }

  private assertNoCoreConflict(): void {
    const unique = [...new Set(this.coreSelections)];
    if (unique.length <= 1) return;
    throw new TypeError(`Conflicting core retrieval strategies: ${unique.join(", ")}.`);
  }
}

export default QueryBuilder;
