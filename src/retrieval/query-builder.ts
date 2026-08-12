"use strict";

import type { MemoryEngine } from "../engine.js";
import type { SearchOptions } from "../types/config.js";
import type { SearchEnvelope } from "../types/documents.js";
import {
  assertValidRetrievalPlanInput,
  mergeRetrievalPlan,
  normalizeRetrievalPlan,
  type RetrievalPlan,
} from "./retrieval-plan.js";
import {
  ExpansionBuilder,
  PostprocessBuilder,
  RerankBuilder,
  ScopeBuilder,
  requireGroupBuilder,
  requireGroupInput,
} from "./query-group-builders.js";
import {
  hasPlanInput,
  mergePlanInputs,
} from "./query-builder-values.js";
import {
  type ExpansionInput,
  type ExternalRerankInput,
  type GroupCallback,
  type PostprocessInput,
  type QueryRunOptions,
  type RetrievalFilterInput,
  type RetrievalPlanInput,
  type CoreStrategy,
} from "./query-builder-types.js";

export {
  ExpansionBuilder,
  PostprocessBuilder,
  RerankBuilder,
  ScopeBuilder,
} from "./query-group-builders.js";
export type {
  ExpansionInput,
  ExternalRerankInput,
  PostprocessInput,
  RetrievalFilterInput,
  RetrievalPlanInput,
} from "./query-builder-types.js";

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
    options: { inheritDefaults?: boolean; core?: CoreStrategy } = {},
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
      { strategy: "associative", associative: { enabled: true, tagBasisProjection: enabled } },
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
      { strategy: "associative", associative: { enabled: true, tagGraphPropagation: enabled } },
      { core: "associative" },
    );
  }

  graphDiffusion(enabled = true): QueryBuilder {
    return this.next(
      { strategy: "associative", associative: { enabled: true, tagGraphPropagation: enabled } },
      { core: "associative" },
    );
  }

  propagationSupport(enabled = true): QueryBuilder {
    return this.next(
      { strategy: "associative", associative: { enabled: true, propagationSupport: enabled } },
      { core: "associative" },
    );
  }

  propagationStructure(enabled = true): QueryBuilder {
    return this.next(
      { strategy: "structural", structural: { enabled: true, propagationStructure: enabled } },
      { core: "structural" },
    );
  }

  propagationHistory(enabled = true): QueryBuilder {
    return this.next({ propagationHistory: { enabled } });
  }

  embeddingRerank(enabled = true): QueryBuilder {
    return this.next(
      { strategy: "associative", associative: { enabled: true, embeddingRerank: enabled } },
      { core: "associative" },
    );
  }

  tagExpansion(enabled = true): QueryBuilder {
    return this.next(
      { strategy: "associative", associative: { enabled: true, tagExpansion: enabled } },
      { core: "associative" },
    );
  }

  nativeTagRetrieval(enabled = true): QueryBuilder {
    return this.next(
      { strategy: "associative", associative: { enabled: true, nativeTagRetrieval: enabled } },
      { core: "associative" },
    );
  }

  structuralRelations(enabled = true): QueryBuilder {
    return this.next(
      { strategy: "structural", structural: { enabled: true, relationExpansion: enabled } },
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
    if (typeof input !== "function") assertValidRetrievalPlanInput({ expansion: input });
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
    if (hasPlanInput(this.override)) searchOptions.retrievalPlan = this.override;
    return this.engine.search(this.queryText, searchOptions);
  }

  private assertNoCoreConflict(): void {
    const unique = [...new Set(this.coreSelections)];
    if (unique.length <= 1) return;
    throw new TypeError(`Conflicting core retrieval strategies: ${unique.join(", ")}.`);
  }
}

export default QueryBuilder;
