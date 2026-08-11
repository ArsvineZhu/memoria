# Native Memory System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `memoria` into a host-independent native memory library that preserves the useful VCP retrieval capabilities while owning its MDX source model, derived relationship graph, automatic strategy selection, and Rust-backed memo runtime.

**Architecture:** User-authored MDX under `data/content/` is immutable source authority. A versioned SQLite derived layer stores parsed blocks, explicit links, system-inferred relations, provenance, and graph generations; vector indexes and Rust Memo Artifacts remain rebuildable. Ordinary string queries are converted into a typed `QueryProfile` and `RetrievalPlan`, then routed through a shared semantic/BM25 base, a Concept Field strategy (TagMemo family), or a Relation Topology strategy (RiverMemo/Topology V3), followed by independently configured filtering, reranking, expansion, decay, deduplication, truncation, and formatting.

**Tech Stack:** TypeScript/ESM, Node.js 24, `node:test`, SQLite via `better-sqlite3`, `yaml`, a static MDX/Markdown AST parser, Vexus N-API/Rust MemoRuntime, Corepack pnpm, and existing SearchPipeline stages.

> **Implementation note:** 这份计划最初按较细的文件拆分编写；落地时将查询画像、策略规划和关系图分别合并到 `src/retrieval/query-planner.ts`、`src/retrieval/retrieval-plan.ts` 和 `src/retrieval/relation-graph.ts`，将 field/topology 策略落到现有 memo stage adapter（`tagmemo-*`、`geodesic-reranker`、`topology-v3`）上。这样不会为了满足文件名而增加空壳层。下面的验收以行为、公开 API、诊断和真实 native integration 为准，不以原始文件拆分为准。

## Global Constraints

- Keep `data/content/**/*.mdx` as user-owned source; the engine never rewrites, appends, or normalizes source files.
- Keep generated catalog, relationship evidence, graph artifacts, SQLite, and vector indexes under `data/memoria/`; all derived state must be rebuildable from source plus durable system events.
- Do not expose VCP placeholder syntax as the public library contract. Public callers use typed `MemoryQueryOptions`, `RetrievalPlan`, and collection/profile configuration.
- Preserve ordinary vector + BM25 retrieval, explicit scope/permission filtering, SQLite authority, Vexus recovery, TDB separation, and existing `SearchResult` compatibility fields unless a new versioned field is required.
- Preserve the native Rust MemoRuntime ABI and generated `rust-vexus-lite/index.js`; integrate the existing methods instead of reimplementing Topology V3 in JavaScript.
- `TagMemo` and `RiverMemo` remain internal algorithm/provenance names. User-facing strategy names are `semantic`, `field`, `topology`, and `auto`.
- Explicit MDX links and user metadata outrank inferred relations. Inferred relations must carry confidence, evidence, algorithm version, status, and reversible lifecycle state.
- Hard scope and permission filters apply before graph expansion and again before formatting; related expansion must never escape the resolved scope.
- Every production behavior change follows RED → GREEN → REFACTOR with a focused `node:test` run before broader verification.
- Do not read, modify, migrate, or delete `eval/`.

---

### Task 1: Public retrieval domain model and plan normalization

**Files:**

- Create: `src/retrieval/retrieval-plan.ts`
- Create: `src/retrieval/query-profile.ts`
- Modify: `src/types.ts` around `ExternalReranker`, `MemoryEngineOptions`, `PipelineData`, `PipelineContextLike`, and `SearchEnvelope`
- Modify: `src/index.ts` and `src/index.cts` to export the public retrieval types and normalizers
- Test: `tests/retrieval/test-retrieval-plan.test.ts`

**Interfaces:**

```ts
export type RetrievalStrategy = "auto" | "semantic" | "field" | "topology";

export interface RetrievalPlan {
  strategy: RetrievalStrategy;
  field?: {
    enabled?: boolean;
    geodesicRerank?: boolean;
  };
  topology?: {
    version?: "v3";
    maxHops?: number;
    relatedExpansion?: boolean;
  };
  filters?: {
    spaces?: readonly string[];
    documentIds?: readonly string[];
    recordedAfter?: number | string;
    recordedBefore?: number | string;
    metadata?: Record<string, unknown>;
  };
  externalRerank?: {
    enabled?: boolean;
    mode?: "ordered" | "rrf";
    alpha?: number;
  };
  expansion?: {
    related?: boolean;
    maxHops?: number;
    sameDocument?: boolean;
    fullDocument?: boolean;
    maxAdded?: number;
  };
  postprocess?: {
    timeDecay?: boolean;
    dedupe?: boolean;
    truncate?: boolean;
    maxResults?: number;
    maxContentLength?: number;
  };
}

export interface QueryProfile {
  query: string;
  entities: string[];
  concepts: string[];
  relationHints: string[];
  timeConstraints: Record<string, unknown> | null;
  wantsDirectEvidence: boolean;
  wantsRelatedContext: boolean;
  complexity: number;
  confidence: number;
}

export interface StrategyDecision {
  strategy: Exclude<RetrievalStrategy, "auto">;
  scores: Record<"semantic" | "field" | "topology", number>;
  reasons: string[];
  fallback?: string;
}
```

- [x] **Step 1: Write failing normalization tests**

Cover default `strategy: "auto"`, independent postprocess options, the distinction between `field.geodesicRerank` and `externalRerank.mode`, bounded `maxHops`/`maxAdded`, and rejection of unknown strategy values.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```powershell
corepack pnpm build:test
node --test dist-test/tests/retrieval/test-retrieval-plan.test.js
```

Expected: the new module or exported normalizer is missing.

- [x] **Step 3: Implement plan normalization and public types**

Normalize caller options into a new immutable plan. Clamp numeric bounds, preserve explicit empty scopes, default `strategy` to `auto`, and keep external reranking separate from geodesic reranking.

- [x] **Step 4: Run the focused test and verify GREEN**

Run the same command and confirm every plan normalization case passes.

- [x] **Step 5: Integrate the plan into `PipelineData` without changing stage behavior**

Carry the normalized plan and eventual `QueryProfile` through the pipeline while retaining all legacy top-level option aliases.

### Task 2: Natural-language query profiling and deterministic strategy planning

**Files:**

- Create: `src/retrieval/query-understanding.ts`
- Create: `src/retrieval/strategy-planner.ts`
- Modify: `src/types.ts` for `QueryInterpreter`, `GraphReadiness`, and `StrategyDecision` trace fields
- Modify: `src/core/context.ts` to accept an optional query interpreter and graph readiness provider
- Modify: `src/pipelines/search-pipeline.ts` to run query profiling before memo strategy stages
- Test: `tests/retrieval/test-query-understanding.test.ts`
- Test: `tests/retrieval/test-strategy-planner.test.ts`

**Interfaces:**

```ts
export interface QueryInterpreter {
  interpret(query: string): Promise<Partial<QueryProfile>> | Partial<QueryProfile>;
}

export interface GraphReadiness {
  explicitLinks: number;
  activeInferredLinks: number;
  candidatePathCount: number;
  topologyArtifactReady: boolean;
  permissionScopeReady: boolean;
}

export function profileQuery(
  query: string,
  hints?: Partial<QueryProfile>,
): QueryProfile;
export function chooseStrategy(
  profile: QueryProfile,
  readiness: GraphReadiness,
  plan: RetrievalPlan,
): StrategyDecision;
```

- [x] **Step 1: Write failing query-profile tests**

Cover direct-fact queries, temporal phrases, causal/dependency phrases, multi-entity queries, explicit `memory://` links, empty text, and deterministic repeated output. The tests must assert structured fields rather than a particular implementation keyword list.

- [x] **Step 2: Run the query-profile tests and verify RED**

Run:

```powershell
corepack pnpm build:test
node --test dist-test/tests/retrieval/test-query-understanding.test.js dist-test/tests/retrieval/test-strategy-planner.test.js
```

Expected: missing profiler/planner modules.

- [x] **Step 3: Implement the deterministic profiler**

Extract explicit memory URIs, conservative time expressions, relation hints, entity-like spans, and direct-evidence language. Keep all extracted values confidence-scored and do not require an LLM. Allow an injected `QueryInterpreter` to enrich the profile without making it mandatory.

- [x] **Step 4: Implement the planner**

Use hard gates for explicit strategy overrides, empty permission scopes, unavailable topology artifacts, and missing candidate paths. Otherwise score semantic, field, and topology readiness using query complexity, relation hints, explicit link counts, candidate path counts, and the configured cost budget. Do not use Ω before query observation exists; Ω remains a Topology readout gate.

- [x] **Step 5: Verify the planner and preserve traceability**

Run the focused tests and assert the decision includes strategy, scores, reasons, and fallback. Add `strategyDecision` to the result envelope without removing existing fields.

### Task 3: Immutable MDX source and explicit/derived relationship graph

**Files:**

- Create: `src/relations/relation-types.ts`
- Create: `src/relations/mdx-link-extractor.ts`
- Create: `src/relations/derived-link-policy.ts`
- Modify: `src/utils/mdx-document.ts` to expose stable source spans and frontmatter validation hooks
- Modify: `src/types.ts` for `MemoryRelation`, `RelationEvidence`, and `RelationOrigin`
- Modify: `src/providers/sqlite-metadata-store.ts` with idempotent derived relation tables and CRUD
- Modify: `src/interfaces/metadata-store.ts` with relation ports
- Modify: `src/stages/ingestion/file-reader.ts` and `src/stages/ingestion/metadata-writer.ts` to record source revision and extracted explicit links
- Test: `tests/relations/test-mdx-link-extractor.test.ts`
- Test: `tests/providers/test-relation-store.test.ts`
- Test: `tests/stages/test-relation-ingestion.test.ts`

**Interfaces:**

```ts
export type RelationOrigin = "explicit" | "inferred" | "promoted";

export interface MemoryRelation {
  id: number;
  sourceDocumentId: string;
  sourceChunkId?: number | null;
  targetDocumentId: string;
  targetAnchor?: string | null;
  relation: string;
  origin: RelationOrigin;
  confidence: number;
  weight: number;
  evidence?: RelationEvidence | null;
  sourceRevision?: string | null;
  algorithmVersion?: string | null;
  status: "active" | "stale" | "rejected";
}

export interface RelationStoreContract {
  replaceExplicitRelations(
    documentId: string,
    sourceRevision: string,
    relations: readonly MemoryRelation[],
  ): Promise<void>;
  upsertDerivedRelation(relation: Omit<MemoryRelation, "id">): Promise<number>;
  listRelations(
    documentIds: readonly string[],
    options?: {
      origins?: readonly RelationOrigin[];
      relationTypes?: readonly string[];
    },
  ): Promise<MemoryRelation[]>;
  markStaleForDocument(documentId: string, sourceRevision: string): Promise<void>;
}
```

- [x] **Step 1: Write failing AST/link tests**

Parse ordinary Markdown links, relative `.mdx` links, `memory://` links with anchors, known `<MemoryLink>` components, source spans, malformed targets, and non-memory external URLs. Confirm extraction never executes MDX.

- [x] **Step 2: Run the extractor test and verify RED**

Run:

```powershell
corepack pnpm build:test
node --test dist-test/tests/relations/test-mdx-link-extractor.test.js
```

Expected: missing extractor or missing AST dependency.

- [x] **Step 3: Implement static extraction**

Use a conservative static Markdown/MDX link extractor. Extract standard links as `references`; extract allowlisted `MemoryLink` components as typed relations; preserve source spans and source revision. Do not execute imports, JSX expressions, or arbitrary component code.

- [x] **Step 4: Add derived relation persistence**

Add idempotent SQLite tables for explicit relations, inferred relations, evidence, and generation metadata. Keep source relations replaceable by source revision while preserving system-derived relation history and status.

- [x] **Step 5: Integrate ingestion and verify immutability**

Ingest MDX without writing back to `data/content`. Re-ingesting an unchanged revision must not duplicate edges; replacing a source revision must stale the old explicit edges and preserve unrelated derived edges. Run all focused relation tests.

### Task 4: Concept Field strategy and TagMemo/TagMemo+ native library path

**Files:**

- Create: `src/retrieval/field-strategy.ts`
- Modify: `src/stages/memo/tagmemo-v9.ts`, `src/stages/memo/tagmemo-v10.ts`, and `src/stages/memo/geodesic-reranker.ts` to consume concepts/relations rather than only injected legacy `tagGraph`
- Modify: `src/pipelines/search-pipeline.ts` to activate the strategy from `RetrievalPlan`
- Modify: `src/providers/sqlite-metadata-store.ts` to expose concept/link graph snapshots
- Test: `tests/retrieval/test-field-strategy.test.ts`
- Test: `tests/stages/test-tagmemo-native-path.test.ts`

**Interfaces:**

```ts
export interface FieldStrategyResult {
  candidates: ChunkCandidate[];
  matchedConcepts: string[];
  fieldDiagnostics: Record<string, unknown>;
  geodesic?: GeodesicData;
}

export async function runFieldStrategy(
  query: QueryProfile,
  candidates: readonly ChunkCandidate[],
  ctx: PipelineContextLike,
  options: RetrievalPlan,
): Promise<FieldStrategyResult>;
```

- [x] **Step 1: Write failing field-strategy tests**

Prove explicit MDX concepts and relations seed the field, candidates receive bounded nonnegative field scores, `geodesicRerank` is independently controllable, and missing graph data produces a traceable safe skip.

- [x] **Step 2: Run focused tests and verify RED**

Run:

```powershell
corepack pnpm build:test
node --test dist-test/tests/retrieval/test-field-strategy.test.js dist-test/tests/stages/test-tagmemo-native-path.test.js
```

- [x] **Step 3: Implement the library-native field strategy**

Build a graph snapshot from explicit and active derived relations, retain legacy `tagGraph` as an injection compatibility path, and reuse the existing EPA/residual/scaled-field algorithms. `TagMemo+` semantics must mean field preparation plus geodesic reranking, not external reranking.

- [x] **Step 4: Integrate strategy selection and verify trace**

Run the focused tests and assert the result reports `algorithm: "TagMemo"`, whether geodesic reranking applied, matched concepts, and skip reasons.

### Task 5: Rust MemoRuntime integration and Relation Topology strategy

**Files:**

- Create: `src/native/memo-runtime.ts`
- Create: `src/retrieval/topology-strategy.ts`
- Modify: `src/native/vexus-lite.ts` to type and expose the MemoRuntime methods through an internal facade
- Modify: `src/providers/vexus-vector-store.ts` to expose the owning `VexusIndex` for the Tag graph and memo runtime
- Modify: `src/engine.ts` to build/rebuild the memo artifact after authoritative metadata changes and clear it on close
- Modify: `src/stages/memo/rivermemo.ts` to become a strategy adapter rather than the production Topology implementation
- Modify: `src/types.ts` for artifact, native diagnostics, and stable Topology V3 result fields
- Test: `tests/native/test-memo-runtime-facade.test.ts`
- Test: `tests/retrieval/test-topology-strategy.test.ts`
- Test: `tests/integration/test-native-topology-path.test.ts`

**Interfaces:**

```ts
export interface MemoRuntimeFacade {
  rebuildArtifact(input: string): Promise<NativeMemoArtifactBuildResult>;
  runPipeline(input: string, artifactSig: string): Promise<unknown>;
  senseQuery(input: string, artifactSig: string): Promise<unknown>;
  rerankDtsc(input: string, artifactSig: string): Promise<unknown>;
  rerankTopologyV3(input: string, artifactSig: string): Promise<unknown>;
  clear(): void;
  stats(): MemoRuntimeStats;
}

export interface TopologyStrategyResult {
  candidates: ChunkCandidate[];
  topologyDiagnostics: Record<string, unknown>;
  schema: "rivermemo-topology-v3-result-v1";
  algorithmVersion: "rivermemo.topology-v3.1";
}
```

- [x] **Step 1: Write failing native facade tests**

Inject a fake `VexusIndex` exposing the declared native methods and assert the facade validates artifact signatures, forwards one native request, preserves diagnostics, and clears runtime state. Add a negative test for unavailable MemoRuntime methods.

- [x] **Step 2: Run native facade tests and verify RED**

Run:

```powershell
corepack pnpm build:test
node --test dist-test/tests/native/test-memo-runtime-facade.test.js
```

- [x] **Step 3: Implement the internal native facade**

Extend the current lazy loader without changing generated Rust files. Ensure the `VexusIndex` instance that owns the tag index owns the same MemoRuntime used for artifact rebuild, sensing, DTSC, and Topology V3.

- [x] **Step 4: Write and run the topology strategy RED tests**

Assert explicit permission scopes, candidate serialization, one `rerankTopologyV3` invocation, stable result schema, direct-anchor preservation, and no silent fallback when the explicit topology strategy is requested.

- [x] **Step 5: Implement the Topology adapter**

Build the native input from query profile, candidate IDs, ordered links, vectors, relation evidence, scope, and prepared fields. Map native IDs back through SQLite. Keep `rivermemo-topology-v3-result-v1` and `rivermemo.topology-v3.1` in the result trace.

- [x] **Step 6: Integrate artifact lifecycle**

Rebuild or invalidate the Memo Artifact when source relations, tags, chunks, or generation state changes. Reuse the current immutable SQLite authority and do not rebuild artifacts mid-query. Run native topology tests against the shipped Windows binding.

### Task 6: Automatic planner and postprocess composition

**Files:**

- Create: `src/retrieval/retrieval-planner-stage.ts`
- Modify: `src/pipelines/search-pipeline.ts` to use a single strategy decision and a fixed postprocess contract
- Modify: `src/stages/retrieval/search-scope-resolver.ts` and `src/stages/memo/tag-expander.ts` for relation-aware scope-safe expansion
- Modify: `src/stages/postprocess/external-reranker.ts`, `time-decay.ts`, `result-deduplicator.ts`, `truncator.ts`, `expander.ts`, and `associator.ts` only where stage contracts need the plan
- Test: `tests/retrieval/test-auto-planner.test.ts`
- Test: `tests/pipelines/test-retrieval-plan-composition.test.ts`

**Interfaces:**

```ts
export interface RetrievalTrace {
  plan: RetrievalPlan;
  profile: QueryProfile;
  decision: StrategyDecision;
  stageOrder: string[];
  fallbacks: string[];
}
```

- [x] **Step 1: Write failing composition tests**

Cover `TagMemo+` as field + geodesic, topology + external RRF, hard scope before expansion, time candidates protected from topology rewrites, dedupe after expansion, and truncation after final ranking.

- [x] **Step 2: Run composition tests and verify RED**

Run:

```powershell
corepack pnpm build:test
node --test dist-test/tests/retrieval/test-auto-planner.test.js dist-test/tests/pipelines/test-retrieval-plan-composition.test.js
```

- [x] **Step 3: Implement strategy routing**

Run the shared base retrieval, obtain graph readiness, choose one core strategy in `auto` mode, and preserve independent postprocess options. Explicit `field` and `topology` modes bypass automatic choice but retain hard scope gates.

- [x] **Step 4: Implement the fixed stage contract**

The implemented default order is:

```text
scope/permission
→ vector + BM25
→ field or topology strategy
→ related/same-document/full-document/association expansion
→ dedupe
→ external rerank
→ time decay
→ truncation
→ final scope
→ format
```

Every expansion path must resolve through the same scope and every strategy must preserve direct evidence candidates.

- [x] **Step 5: Verify existing stages and compatibility surface**

Run existing memo/postprocess suites plus the focused composition tests. Keep `KnowledgeBaseAdapter` only as a compatibility wrapper; its enhanced methods must report unavailable capability rather than silently claim a native result once the native path is active.

### Task 7: MDX data layout, examples, documentation, and migration contract

**Files:**

- Modify: `README.md`, `docs/GUIDE.md`, `docs/ARCHITECTURE.md`, `docs/FUNCTIONS.md`, `docs/RETRIEVAL_FEATURES.md`, `docs/API.md`, `docs/PERSISTENCE.md`, `docs/TROUBLESHOOTING.md`
- Create: `docs/RELATIONS.md`
- Create: `docs/RETRIEVAL_PLAN.md`
- Modify: `examples/demo/` to demonstrate immutable MDX, explicit links, inferred relation traces, and `strategy: "auto"`
- Test: `tests/integration/test-mdx-relation-demo.test.ts`

**Interfaces:**

- Human documentation remains Simplified Chinese.
- Public examples use ordinary strings plus typed options; no VCP placeholder syntax.
- Docs distinguish source truth, derived relation truth, rebuildable artifacts, and compatibility APIs.

- [x] **Step 1: Write the demo contract test**

Verify MDX files remain byte-for-byte unchanged after ingest/search, explicit links are extracted, derived links are stored outside `data/content`, and result traces expose the selected strategy.

- [x] **Step 2: Run the demo contract test and verify RED**

Run:

```powershell
corepack pnpm build:test
node --test dist-test/tests/integration/test-mdx-relation-demo.test.js
```

- [x] **Step 3: Update the demo and docs from implemented behavior**

Document the typed search API, strategy meanings, relation lifecycle, native requirements, safe MDX parsing, and explicit fallback behavior. Do not document unavailable behavior as complete.

- [x] **Step 4: Run documentation and demo checks**

Run:

```powershell
corepack pnpm verify:docs
corepack pnpm build:test
node --test dist-test/tests/integration/test-mdx-relation-demo.test.js
```

### Task 8: Full verification and completion audit

**Files:**

- Modify: tests or docs only when a verified contract gap is found.
- No changes to `eval/`.

- [x] **Step 1: Run the focused suites for every subsystem**

Run the retrieval, relations, native, pipeline, memo, postprocess, engine, adapter, and TDB suites after the implementation tasks are complete.

- [x] **Step 2: Run repository gates**

```powershell
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm typecheck:public
corepack pnpm test
corepack pnpm verify:public
corepack pnpm verify:pack
git diff --check
```

- [x] **Step 3: Run native runtime evidence**

Exercise artifact rebuild, native observation, DTSC, Topology V3, one-hop explicit links, multi-hop derived links, direct anchor, explicit empty scope, and topology-unavailable failure through a real `MemoryEngine` using the shipped Windows binding.

- [x] **Step 4: Audit every objective requirement**

Verify that MDX source is immutable, derived links are durable and reversible, ordinary natural-language queries work without query MDX, `auto` strategy selection is explainable, field and topology strategies are native-backed, TagMemo+/RiverMemo+ semantics are preserved, outer processing is composable, and compatibility behavior does not silently advertise unavailable enhancements.

- [x] **Step 5: Report remaining uncertainty honestly**

Report any provider-dependent skips, unavailable external reranker credentials, or platform-native gaps separately from passing local checks. Mark the active goal complete only after all requirements have current evidence.
