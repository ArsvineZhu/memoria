# Memoria Next Architecture Design

**Status:** Approved architecture design for the next major generation of Memoria.  
**Date:** 2026-08-13  
**Repository baseline:** `master` at `a1185f694318a4eb265f4754af4dc63ce8f8704b` (`release: 0.2.0`) when this design was consolidated.  
**Scope:** architecture and behavioral contracts only. This document does not select every storage library, ANN implementation, binary artifact layout, encryption primitive, or ranking coefficient.

---

## 1. Purpose

Memoria Next is a local-first embedded long-term memory engine for AI hosts, designed first for Heptalogos but deliberately host-agnostic. It stores durable, evolving memory documents, incrementally compiles them into multiple retrieval representations, executes structured retrieval deterministically, and learns bounded retrieval habits from explicit Host feedback.

The system is not a conversational agent and does not perform query-time language understanding. The Host/Agent resolves language, identities, deixis, temporal intent, and authoring intent before invoking Memoria.

The architectural center is:

> **Restricted MDX is the only long-term Memory Authority language; a deterministic Rust compiler lowers it to rebuildable Canonical Memory IR and capability-specific retrieval artifacts.**

Memoria Next is a hard architectural reset from the 0.2 line. The new major does not preserve old API, database schema, native ABI, configuration aliases, or on-disk compatibility. If migration is ever required, it is a standalone one-shot offline converter outside the core runtime.

---

## 2. System Goals

The design optimizes for:

1. long-term continuity without depending on an ever-growing chat context;
2. stable identity and explicit historical semantics;
3. local-first operation with useful offline retrieval;
4. rebuildable and evolvable retrieval infrastructure;
5. deterministic, inspectable query execution rather than hidden query-time agents;
6. incremental compilation and provider-cost reuse;
7. bounded adaptive recall behavior without self-reinforcing ranking loops;
8. strong crash recovery and snapshot consistency;
9. clear privacy and data-governance boundaries;
10. clean separation between Host cognition and memory-engine computation.

### 2.1 Explicit non-goals

Memoria Core does not:

- record raw IM traffic as its primary memory model;
- decide which chat messages deserve long-term memory;
- summarize conversations into memory automatically;
- resolve `I`, `you`, `he`, `there`, `before`, nicknames, or ambiguous names at query time;
- infer real-world identity from names, embeddings, or top-ranked candidates;
- infer causality or authoritative relations from vector similarity or Tag association;
- generate the final natural-language answer to a recall request;
- replace authoritative external systems such as GitHub, Calendar, task databases, or application state stores;
- expose a fixed BM25/vector/graph pipeline as the product API;
- provide arbitrary executable MDX or extension code;
- support multiple independent embedded writer processes for one Store in V1;
- provide distributed replication or multi-writer synchronization in V1.

---

## 3. Architectural Invariants

The design is governed by the following top-level invariants:

1. **MDX is the only Memory Authority.**
2. **Host understands language and real-world identity; Memoria does not guess them.**
3. **Authority is durable; Derived is rebuildable; Adaptive is experiential.**
4. **Stable semantic identity is separate from physical retrieval identity.**
5. **Authority commits first; retrieval capabilities converge asynchronously.**
6. **Queries pin explicit snapshots and return evidence, not generated conclusions.**
7. **Semantic constraints never degrade silently.**
8. **Global addressability does not imply retrieval visibility.**
9. **Global Tag identity does not imply global association evidence.**
10. **Retrieved data is not instruction authority.**
11. **Adaptive behavior can bias relevant recall but cannot manufacture relevance.**
12. **Deletion/privacy governance may invalidate reproducibility; forbidden data is not retained merely to preserve an old computation.**

These invariants take precedence over local implementation convenience.

---

## 4. Responsibility Boundaries

### 4.1 Host / Agent responsibilities

The Host owns:

- raw message/event ingestion;
- conversation/session context;
- sender, recipient, mention, and participant binding;
- Host Identity Directory;
- natural-language and intent understanding;
- pronoun/deixis resolution;
- real-world time interpretation such as resolving “university sophomore year” to an actual interval;
- deciding what deserves long-term memory;
- deciding whether new information is `CREATE`, `ADD`, `UPDATE`, `TRANSITION`, `CORRECT`, or `NO-OP`;
- selecting/discovering Spaces and existing Memory owners;
- Referential Closure before canonical memory writes and structured query cues;
- final reasoning across one or more retrieved memories;
- response generation;
- explicit feedback indicating which retrieval evidence was used or rejected;
- authorization and Agent tool permissions.

### 4.2 TypeScript control plane

The TypeScript layer owns:

- ergonomic public domain API;
- typed authoring helpers and MDX serialization;
- Host integration adapters;
- Provider Host and network side effects;
- credentials, proxy, retry/backoff, rate limits, and HTTP;
- external embedding, reranking, and optional Tag-enrichment providers;
- Agent Tool adapters and Skill packaging.

### 4.3 Rust Core

Rust owns the canonical state and computation plane:

- Store/Space/Memory/Revision Authority;
- CAS and transactional integrity;
- canonical MDX parse/validation/canonicalization;
- lossless/source-aware syntax representation for patching;
- Canonical Memory IR;
- incremental compiler and dependency invalidation;
- structural, lexical, temporal, relation, entity, Tag, graph, and vector retrieval structures;
- query planning and execution;
- ranking evidence, consolidation, and Recall Assessment;
- Adaptive event validation, reducers, and materialized state;
- integrity verification, GC coordination, and recovery.

Core principle:

> **Rust owns computation state; TypeScript owns external side effects.**

---

## 5. Identity, Addressing, and Discovery

### 5.1 Identity classes

Use three identity strategies:

- mutable logical identities: cryptographically secure random opaque IDs;
- immutable objects: cryptographic content/commit hashes;
- ordering/snapshot identities: monotonic integer generations.

Conceptually:

```text
StoreId              ST_<random>
SpaceId              S_<random>
MemoryId             M_<random>
RevisionId           R_<commit-hash>
SourceBlobHash       B_<content-hash>
AuthorityGeneration  uint64
AdaptiveGeneration   uint64
```

Exact hash algorithm, byte length, and Base32 spelling remain implementation selections, but the identity semantics above are fixed.

### 5.2 Store and Space locators

`StoreId` identifies a local Authority universe but does not imply replication semantics.

A Space has:

- Memoria-generated immutable `SpaceId`;
- caller-controlled Store-scoped unique `SpaceKey`;
- optional name/description descriptor;
- lifecycle state.

`SpaceKey` is a discovery locator, not permanent identity, and can change through Authority state transitions.

### 5.3 Memory identity and DocumentKey

A MemoryDocument has a Memoria-generated immutable `MemoryId`.

It may also have an optional caller-controlled, Space-scoped `DocumentKey`:

```text
(SpaceId, DocumentKey) -> MemoryId
```

`DocumentKey` may be renamed without changing `MemoryId`. Retired memories continue occupying their DocumentKey by default, preventing ambiguous restore behavior. Key reuse requires explicit rename or purge.

### 5.4 EntityRef

Real-world entity identity is not issued by Memoria.

The Host owns `EntityRef` and uses a namespace-qualified opaque grammar:

```text
<namespace>:<opaque-id>
```

Examples:

```text
person:7K4Q...
agent:A81F...
project:P91D...
place:L7C3...
```

The namespace is an identity domain, not Memoria ontology. Memoria validates grammar/length but does not attach built-in meaning to `person`, `place`, or application-specific namespaces.

Host platform-account bindings, aliases, merges, and splits remain outside Memoria.

### 5.5 Entity discovery

Identity authority and discovery are distinct:

1. conversation-context binding;
2. Host Identity Directory lookup;
3. Memoria Entity Observation Discovery when identity is still unresolved.

Memoria maintains a Derived Entity Observation Index from authoritative MDX occurrences. It may answer “which known EntityRefs were observed with this surface/context?” but never decides that the top candidate is the real entity.

Formal Memory queries receive resolved `EntityRef` values, not names pretending to be identities.

### 5.6 MemoryRef

Memory references support:

- logical Memory reference: `MemoryId`, resolved to HEAD under the query snapshot;
- logical semantic-node reference: `MemoryId + SemanticNodeId`;
- pinned historical reference: `MemoryId + RevisionId (+ SemanticNodeId)`.

If a logical node no longer exists at the selected HEAD, resolution is explicitly unresolved. Memoria never searches history for a “similar replacement.”

---

## 6. Authority Model

Authority is a generation-versioned Store topology plus immutable Revision DAG plus content-addressed raw MDX object graph.

### 6.1 Core objects

```text
Store
├─ Space*
└─ MemoryDocument*
   ├─ Revision*
   │  └─ SourceBlob
   └─ snapshot-versioned document state
      ├─ Space assignment
      ├─ DocumentKey
      ├─ canonical HEAD
      └─ lifecycle
```

Transactional/governance records also include AuthorityGeneration, mutation/idempotency records, import provenance, and backup/restore metadata.

### 6.2 Memory identity versus current state

`MemoryDocument` permanent identity is deliberately minimal. The following are snapshot-versioned state, not permanent identity fields:

- Space assignment;
- DocumentKey;
- HEAD Revision;
- active/retired lifecycle.

At each Authority snapshot, a non-purged Memory belongs to exactly one Space and has at most one effective state.

### 6.3 Revision DAG

A Revision is immutable and belongs to exactly one MemoryDocument. A normal revision has one parent; a merge revision may have multiple parents. All parents must belong to the same MemoryDocument, and the graph must remain acyclic.

Memoria validates DAG topology but never semantically merges content. A merge caller supplies a complete valid resulting MDX document.

There is exactly one canonical HEAD per MemoryDocument. There are no named branches as a product concept.

### 6.4 Revision identity

A Revision ID is a cryptographic hash of a canonical immutable revision-commit object, conceptually:

```text
RevisionCommitV1 {
  formatVersion
  memoryId
  sourceBlobHash
  orderedParentRevisionIds[]
}
```

Operational wall-clock fields such as `committedAt` do not participate in `RevisionId`.

`SemanticHash` is deliberately excluded from Revision identity because semantic compiler interpretation may evolve independently of immutable Authority primitives.

### 6.5 Raw source CAS

Raw submitted MDX bytes are preserved exactly in Rust-managed content-addressed immutable storage.

```text
SourceBlobHash = H(exact raw MDX bytes)
```

Source storage is deduplicated by content. Multiple Revisions or Memories may reference one blob.

The physical CAS layout is replaceable; Authority stores logical blob hashes, not physical object paths.

### 6.6 SemanticHash

`SemanticHash` is distinct from `SourceBlobHash`:

```text
SourceBlobHash = H(raw source bytes)
SemanticHash   = H(canonical semantic representation under a versioned profile/normalization contract)
```

Formatting or comments may change `SourceBlobHash` without changing `SemanticHash`.

`SemanticHash` is compiler/Derived metadata and is not an Authority identity primitive.

### 6.7 AuthorityGeneration

Every committed bounded atomic Authority mutation advances the Store-wide monotonic generation exactly once.

A multi-object batch that revises, creates, retires, or moves several memories produces one new generation, so all changes become visible atomically in the same logical snapshot.

`committedAt` is wall-clock metadata; ordering is defined by AuthorityGeneration.

### 6.8 Bitemporal semantics

Knowledge time and world-valid time are separate:

```text
Knowledge time   = Authority snapshot / Revision reachability
World-valid time = explicit semantic temporal values in MDX
```

This supports questions such as “what was valid then?” versus “what did the system know at that time?” without conflating the two.

### 6.9 Revision versus world change

A Revision only means the document representation changed. It does not inherently mean:

- the world changed;
- the prior state was wrong;
- the new state supersedes every previous fact.

World transitions, supersession, and epistemic correction are explicit semantic operations/content.

### 6.10 Lifecycle

Normal lifecycle states are `active` and `retired`.

- `retire`: removes the memory from default current retrieval while preserving identity, HEAD, DAG, and pinned historical access;
- `restore`: returns the same Memory identity to active lifecycle;
- `purge`: irreversible governance operation that removes Authority identity/history and associated managed Derived/Adaptive/cache information. Purge is not an ordinary document lifecycle value.

### 6.11 Space move

Moving a Memory between Spaces is Authority topology mutation and does not create an MDX Revision. `MemoryId`, Revision DAG, and source content remain unchanged. Target DocumentKey uniqueness is checked explicitly; there is no automatic suffixing.

Historical snapshots reconstruct the old Space assignment.

Adaptive history remains associated with the Space in which each event occurred and does not migrate with the Memory.

### 6.12 Cross-Space references

References may target Memories in another Space. Query scope never expands implicitly. A query scoped to Space A cannot read, traverse, rank with, or consume content/Tag/graph/adaptive evidence from Space B unless B is explicitly in scope.

### 6.13 Idempotency

Identity-creating and other retry-sensitive mutations support explicit idempotency keys.

Same key + same canonical request fingerprint returns the original result. Same key + different request conflicts. Different keys may intentionally create distinct objects even when semantics are identical.

### 6.14 Bounded atomic mutation batch

A batch contains finite typed operations, preconditions, optional idempotency, and resource limits. Rust resolves locators, validates all content and references, prepares durable CAS blobs, then performs one short Authority SQLite transaction with all preconditions rechecked.

No long-lived JavaScript transaction spans Agent reasoning or Provider work.

### 6.15 Read sessions

A ReadSession pins logical snapshot identities:

```text
AuthorityGeneration
DerivedManifestId
AdaptiveSnapshot
```

It does not hold a long-lived SQLite transaction. If required old artifacts are no longer retained, operations fail with `SNAPSHOT_UNAVAILABLE`; they never silently upgrade to newer state.

Pagination continuations pin the same snapshot and query fingerprint for a bounded lease period.

---

## 7. Memoria MDX Profile

Memoria accepts a restricted declarative MDX profile, not arbitrary executable MDX.

### 7.1 Profile properties

Allowed conceptual surface:

```text
ordinary Markdown
+ closed Core semantic elements
+ namespaced opaque declarative extensions
```

Disallowed:

- imports;
- JavaScript expressions;
- runtime components;
- eval/side effects;
- arbitrary executable code;
- automatic plugin installation/loading from document contents.

Core element attributes use literal declarative values; they are never evaluated.

Raw HTML is not part of the initial safe profile. Source-preserved HTML-style comments may be supported as non-semantic trivia.

### 7.2 Topology metadata does not live in MDX

MDX does not carry Store storage identity fields such as:

- `MemoryId`;
- `SpaceId`;
- `RevisionId`;
- parents;
- `DocumentKey`;
- `AuthorityGeneration`;
- `committedAt`.

Those belong to Authority topology or export/backup envelopes.

Document title is normal document content, typically the H1, and may be Derived into catalog views.

### 7.3 Structural and semantic hierarchy

Markdown headings/blocks form a structural hierarchy used for navigation/context/retrieval. Ordinary Markdown blocks do not automatically acquire Authority reference identity.

Explicit Semantic Nodes carry document-local stable `SemanticNodeId` values. Referenceability is opt-in.

A `SemanticNodeId` is unique across the whole MemoryDocument, stable across revisions, and cannot silently change Core semantic type across the same lineage.

### 7.4 Core semantic roles

The initial profile must cover the following semantic roles, while final surface spelling is defined by the normative profile specification before implementation:

- document semantic metadata;
- explicit referenceable Section;
- Entity occurrence/binding;
- explicit Tag annotation;
- State;
- Event;
- Relation;
- MemoryRef;
- Source provenance;
- Quote;
- namespaced Extension.

Core behavior vocabulary remains deliberately small. Caller-defined `class` is arbitrary classification/filter/search metadata and does not introduce new Core execution semantics.

### 7.5 Entity

An inline Entity occurrence binds visible surface text to a Host-provided `EntityRef`:

```mdx
<Entity ref="person:7K4Q...">Zhang San</Entity>
```

Visible surface participates in text projections; stable ref participates in structural indexes and Entity Observation Discovery.

Core semantic nodes can separately declare structural `about` bindings. Inline textual occurrence and semantic ownership are distinct concepts.

### 7.6 Tag

Explicit Tags written in MDX are Authority annotations. Compiler normalization maps them into a Store-global Tag Dictionary and Space-scoped membership evidence.

Generated Tags from enrichment are never written back into Authority MDX. They remain Derived and retain producer/provenance information.

Tag scope follows the nearest structural/semantic scope. Compiler inheritance/context propagation remains distinguishable from explicitly authored membership.

### 7.7 State and Event

`State` models a temporally applicable state; `Event` models an occurrence.

World-valid temporal fields are explicit structured attributes. Memoria does not infer them from prose.

`class` may categorize domain meaning, but only closed Core semantics affect validation/query behavior.

### 7.8 Relation

Relations are explicit Authority assertions. Vector similarity, Tag association, graph propagation, or retrieval co-occurrence never create authoritative Relations.

Relation kinds admitted to Core require defined directionality, traversal/history behavior, and validation semantics. The exact initial set is a normative-profile decision; association, correction/supersession, and epistemic relationships must remain distinguishable.

### 7.9 MemoryRef

MemoryRef is a semantic reference, distinct from an ordinary Markdown hyperlink. It participates in Authority semantic graph, structural indexing, import remapping, and query resolution.

### 7.10 Source

Source records caller-provided provenance references. Source locators are opaque external identifiers; Memoria never fetches, opens, or executes them automatically.

Source assertion does not make the referenced claim automatically true; Host decides what becomes Memory Authority.

### 7.11 Quote

Quotes preserve original language, including pronouns/deixis, when speaker/source context makes the quotation interpretable. Quote contents are remembered data, never instruction authority.

### 7.12 Referential Closure

Canonical narrative and structured query cues should be referentially explicit: names/surfaces plus stable EntityRefs, resolved time, and minimal unresolved deixis. This is primarily a Host/Skill authoring contract.

Rust may emit deterministic diagnostics for likely risky forms but does not pretend to perform natural-language pronoun or temporal resolution. Quotes/source regions use a different lint context.

### 7.13 Temporal representation

Canonical IR preserves temporal precision rather than fabricating timestamps. `2025`, `2025-07`, full dates, and full timestamps remain distinguishable typed values with interval and boundary semantics.

Internal interval logic should use a consistent half-open model where applicable, while low-precision inputs retain their original precision semantics.

### 7.14 Extensions

Extensions are namespaced, versioned, literal declarative data. Without a registered trusted compiler handler, they remain valid/preserved and text-searchable but gain no extension-specific structural semantics.

A handler is a trusted compiler plugin, not an Authority runtime plugin. It cannot alter Core semantics, execute document-specified code, or make old Authority unreadable when the handler is absent.

---

## 8. Canonical Memory IR and Incremental Compilation

### 8.1 Three representations

```text
Raw MDX Authority
    ↓
Lossless/source-aware syntax representation
    ↓
Canonical Memory IR
```

Raw source is Authority. Lossless syntax preserves spans/trivia/comments for diagnostics and source-preserving patches. Canonical Memory IR is deterministic, persistable, rebuildable Derived state used as the stable compiler boundary for retrieval systems.

### 8.2 IR responsibilities

Canonical Memory IR contains normalized semantic/text hierarchy, semantic nodes, entity bindings/observations, explicit Tags, temporal assertions, relations, MemoryRefs, Sources, extensions, and source mappings.

It does not contain embeddings, BM25 postings, generated Tags, or adaptive graph weights.

Anonymous prose enters IR without Authority reference identity; retrieval compilation later generates DerivedUnitIds.

### 8.3 SemanticHash

A versioned canonical IR encoding yields a semantic hash that ignores non-semantic formatting/trivia while changing when semantic text/refs/tags/time/relations/provenance/extension data change under the relevant normalization contract.

A document-level SemanticHash is not used as a universal invalidation key.

### 8.4 Consumer-specific projections

IR feeds independent deterministic projections, including:

- lexical;
- structural;
- temporal;
- relation;
- entity observation;
- explicit Tag;
- local embedding view;
- contextual embedding view;
- enrichment view;
- rerank view.

Every projection owns a version, dependency contract, and input hash.

Raw MDX is never sent directly to embedding/reranking/enrichment providers.

### 8.5 Invalidation model

Invalidation is semantic-diff and dependency driven, not “file changed, rebuild all.” Examples:

- whitespace/comment-only change: semantic artifacts remain reusable;
- prose change: lexical/affected vector/enrichment projections change;
- Entity surface change: lexical/vector/Entity Observation change, stable ref may remain;
- EntityRef-only change: structural/Entity Observation change, visible embedding may remain reusable;
- Tag-only change: Tag membership/graph changes; content embedding remains reusable unless a projection explicitly incorporates Tag context;
- temporal metadata change: temporal artifacts change; content embedding does not by default;
- Source-locator change: provenance changes without automatically invalidating content vectors.

### 8.6 Retrieval hierarchy

Compiler creates deterministic physical Retrieval Units from semantic/Markdown hierarchy, preferring semantic boundaries, paragraphs/lists/sentences, and using model token limits only as a final physical constraint.

Representations may exist at leaf, semantic-node, section, and document resolutions. Materialization is selective and controlled by retrieval compilation policy, not MDX author hints.

`SemanticNodeId` is long-term semantic identity. `DerivedUnitId` is compiler-generated retrieval/cache identity and never appears in Authority references.

### 8.7 Payload and membership separation

Derived content payloads and retrieval target membership are separate. Identical compiled text/vector payloads may be shared across Revisions/Memories while membership remains pinned to exact `(MemoryId, RevisionId, unit/node)` targets.

This allows unchanged historical content to reuse vectors without conflating historical identities.

---

## 9. Derived Plane and Artifact Publication

### 9.1 Artifact families

Derived is composed of independently versioned artifact families such as:

```text
IR
lexical
structural
temporal
relations
entity observations
explicit tags
local/context vectors
generated tags
Tag membership / association evidence / Tag graph
planner statistics
semantic diffs
```

Each family carries producer/projection version, Authority coverage, compatibility/dependency signature, physical location, status, and integrity metadata.

### 9.2 Derived Manifest

A Derived Manifest is an immutable serving view that pins one compatible set of already built/validated artifact generations. Query execution never mixes “latest of each family” ad hoc.

A manifest may therefore intentionally combine current local deterministic indexes with somewhat older vectors/generated Tags, and must report that coverage accurately.

### 9.3 Publication rule

Artifact construction is incremental; query visibility is Manifest-atomic.

Build artifacts invisibly, validate them, create an immutable compatible Manifest, then atomically advance the serving pointer. Existing queries continue reading their pinned old Manifest.

### 9.4 Base readiness

`BaseReady` is provider-independent and requires only local deterministic capabilities such as IR, structural, lexical, temporal, relations, and explicit Tags.

External embedding, reranking, or enrichment failure cannot prevent Authority commit or eventual BaseReady.

### 9.5 Artifact dependency graph

Build scheduling is dependency-aware. Provider-dependent work is emitted only after deterministic projection generation and policy checks. Failure blocks only dependent capabilities.

Provider work is deduplicated by projection/cache identity and may be cancelled if superseded before expensive execution.

### 9.6 Cache identity

Embedding cache identity is based on projection input hash + projection/version + model signature + task contract + dimension/normalization, not MemoryId or whole-file hash.

Tag embeddings are globally reusable by normalized Tag and model/projection signature. Rerank caches respect pointwise/pairwise/listwise semantics; listwise identity includes the ordered candidate set.

Final RetrievalResponse caching is not a V1 optimization target because the dependency surface is large and Adaptive state changes independently.

### 9.7 Generated Tag provenance

Generated Tags retain normalized value, producer signature, enrichment projection/input identity, source scope, and confidence only if the provider contract provides meaningful confidence.

Explicit and generated Tag evidence remain distinct in graph/ranking logic.

### 9.8 Segment architecture

Large mutable retrieval structures should use immutable base/delta segments plus background compaction rather than in-place mutation of actively queried files. This applies conceptually to lexical postings, vector indexes, and packed graph data.

The exact library/format is an implementation benchmark decision, but any selected engine must support snapshot-stable incremental publication.

### 9.9 Catalog

A Derived catalog database stores metadata/control-plane information such as artifact generations, dependencies, compatibility signatures, build jobs, manifests, leases, and GC state. Large hot data remains in formats appropriate to its access pattern rather than being forced into SQLite.

### 9.10 Full rebuild and provider migration

Derived can be rebuilt entirely from Authority (plus external Providers where required) while the previous serving Manifest continues operating.

Changing embedding/provider/index/compiler configuration builds side-by-side replacement generations and publishes them only when ready; it does not immediately destroy current serving artifacts.

---

## 10. Structured Query Contract

### 10.1 Core model

The public query model is **Structured Retrieval Intent + Typed Hard Constraints**, not fixed strategy modes and not a public physical query AST.

Conceptually:

```text
MemoryQuery
├─ scope
├─ cue
│  ├─ text
│  ├─ tags
│  ├─ entities
│  └─ memories
├─ constraints
├─ temporal / knowledge semantics
├─ history semantics
├─ relation semantics
├─ consistency / capabilities
└─ retrieval budget
```

### 10.2 Cue versus constraint

Cue values are candidate-generation/ranking signals. Constraints define admissible results.

An `EntityRef` used as a cue is not equivalent to “the returned result must explicitly contain this entity.” Public types keep these concepts separate.

### 10.3 Scope

Query scope must be explicit: one or more Spaces, or an explicit `all` value. Omitted scope does not silently mean the entire Store.

Cross-Space references never expand scope automatically.

### 10.4 Host-resolved semantics

Query text is a retrieval cue, not a natural-language command language. Host resolves identities, relative time, deixis, and historical intent before submitting the query.

Memoria may tokenize/embed cue text but does not infer that “I” means a specific user, that “university years” means specific dates, or that “why later” implies a history/causal mode.

### 10.5 Capability-aware consistency contract

A query explicitly states:

- Authority freshness/snapshot: latest, at-least generation, or ReadSession snapshot;
- required capabilities;
- preferred capabilities;
- readiness behavior: bounded wait or explicit failure.

Required capability unavailable at the required Authority coverage means wait or fail. Preferred capability may be omitted/degraded deterministically, and the response reports actual coverage and degradation.

Semantic constraints are never degradable. Retrieval accelerators/ranking capabilities may degrade only when the caller permits it.

Stable public capability groups describe semantic retrieval abilities, not physical pipeline knobs. Candidate groups include base-search, lexical, semantic, structured, temporal, associative, reranking, and adaptive; the exact minimal public vocabulary is finalized during API specification.

### 10.6 Query snapshot

Each query pins:

```text
Authority snapshot
+ Derived Manifest
+ Adaptive snapshot
```

The response records these identities.

### 10.7 Budgets

Public budgets include at least:

- `maxResults`;
- `maxMatchesPerResult`;
- total evidence/token budget.

Planner-private operator/candidate/graph/ANN budgets remain internal.

---

## 11. Query Planner and Retrieval Runtime

### 11.1 Planner

V1 uses a deterministic rule/cost-aware planner. It chooses physical operators based on query structure, capabilities, artifact coverage, corpus statistics, budget, and cache state.

Planner may evolve to use learned cost models later, but semantic constraints and budgets remain invariant.

### 11.2 Candidate channels

Internal candidate-generation channels include:

- exact/structural lookup;
- lexical retrieval;
- semantic vector retrieval;
- explicit Tag seeds;
- semantic Tag seeds;
- Space-local Tag association/propagation;
- explicit Relation/MemoryRef expansion;
- historical/change retrieval.

Not every query runs every channel.

Exact identities and typed structural predicates are preferred over probabilistic similarity whenever available.

### 11.3 Hierarchical retrieval

Planner may use coarse-to-fine or fine-to-aggregate strategies over leaf/node/section/document representations. Hierarchy is a data model, not a fixed top-down algorithm.

### 11.4 Tag architecture

Tag identity/normalization/vector cache is Store-global. Membership, co-occurrence, static association evidence, graph topology, propagation evidence, and Adaptive association are Space-scoped.

Cross-Space queries build an ephemeral deterministic CompositeAssociationView; they never merge learned association state permanently.

### 11.5 Tag Basis Projection and Residual Decomposition

These existing Memoria ideas remain candidate physical operators:

```text
q = q_tag + q_residual
```

A small set of semantic/explicit Tag vectors may form a numerically stable Tag subspace. Tag-explained query components can drive Tag association retrieval; residual components can drive direct semantic retrieval, reducing double-counting of the same vector semantics.

This is vector-space computation, not language understanding.

The operator is skipped when the basis is low-quality, ill-conditioned, rank-deficient, or insufficiently explanatory. Numerical implementation (e.g. rank-revealing QR or small SVD) is benchmarked rather than preserving old naive implementation by default.

### 11.6 Propagation

Activation Propagation and Graph Diffusion remain bounded physical graph operators. Planner selects/omits them according to seed quality, budget, graph state, and query needs.

Hard limits cover active Tags, edge visits, hops/iterations, activation threshold, frontier pruning, and cost budget.

Compressed provenance retains seed source, hop/support information, path diversity/support features, and static/adaptive contributions as needed for ranking/diagnostics.

### 11.7 Relations versus associations

Explicit Relation semantics remain separate from Tag association. Association paths can discover related evidence but never establish causality, correction, or other Authority relationships.

Relation traversal obeys query scope and relation-kind semantics.

### 11.8 Evidence fusion

Candidate evidence remains multi-channel internally instead of collapsing immediately into one opaque score.

V1 should use robust rank/evidence fusion baselines such as rank-based fusion plus channel-specific normalized evidence before considering learned fusion. Hierarchical representations derived from overlapping source text are correlation-suppressed and do not count as independent evidence merely because they appeared in multiple resolution indexes.

### 11.9 Consolidation

Raw hits consolidate by `(MemoryId, RevisionId)` into `MemoryResult` objects. Each result contains multiple compact `MemoryMatch` evidence targets.

Within one Revision, overlapping leaf/node/section matches are merged around meaningful semantic anchors so a large document cannot dominate output with near-duplicate fragments.

Result aggregation uses a strong best-match contribution plus bounded/diversity-aware additional support rather than unbounded score summation.

### 11.10 Reranking

Optional external reranking occurs only after candidate fusion/consolidation has reduced the candidate set. Reranker receives deterministic RerankView data, not raw MDX or internal topology noise unless explicitly required by its projection contract.

Reranking may reorder admissible candidates but cannot create new facts, change scope, or reintroduce candidates rejected by hard constraints.

### 11.11 Recall Assessment

Recall Assessment is deterministic/statistical from retrieval trace features, not an LLM judgment.

Keep at least four concepts distinct:

- relevance;
- retrieval confidence;
- accessibility;
- effort.

Retrieval confidence is not factual truth confidence. Accessibility is cue/context/Adaptive-dependent. Effort reflects actual execution complexity, not just elapsed latency.

---

## 12. Retrieval Response and Feedback Handles

### 12.1 Response shape

Conceptually:

```text
RetrievalResponse
├─ retrievalId
├─ snapshot
├─ capability/degradation execution report
├─ MemoryResult[]
└─ continuation/diagnostics as requested
```

Each `MemoryResult` represents one exact `(SpaceId, MemoryId, RevisionId)` and contains one or more `MemoryMatch` entries.

Historical queries may therefore return multiple Revisions of the same Memory as distinct results.

### 12.2 Match identity

A match may target leaf, semantic node, section, or document representation. Long-lived explanation/feedback should prefer Revision + SemanticNode where available; `DerivedUnitId` remains physical compiler identity.

### 12.3 Evidence, not answer

Memoria never synthesizes a cross-document natural-language answer. Host/Agent performs temporal, causal, comparative, or narrative reasoning over returned evidence.

### 12.4 Retrieval receipts

A bounded short-lived Retrieval Receipt maps `retrievalId/resultId/matchId` to pinned evidence identities and query-adaptive signature for feedback and continuation. Full diagnostic traces are separate and shorter-lived/optional.

---

## 13. Adaptive Plane

### 13.1 Definition

Adaptive Plane records long-lived retrieval-use experience that cannot be reconstructed from MDX Authority.

Durable truth is the append-oriented Adaptive Event Log. Familiarity, cue affinity, Adaptive graph contributions, and other current models are rebuildable materialized state.

### 13.2 Feedback source

Durable learning originates only from explicit Host feedback. Top-K appearance, Recall Assessment, or “returned but not used” never automatically generate positive/negative events.

Feedback examples include `used`, explicit rejection/incorrect-for-query, query-level sufficiency outcomes, and optional pairwise preference.

### 13.3 Event semantics

Events record observations, not model conclusions. They pin exact retrieval evidence, Space-at-event, Authority context, target Revision/SemanticNode where available, outcome, time, and a structured/hashed query-adaptive signature.

Raw query text is not retained by default.

### 13.4 Space scoping

Adaptive evidence is Space-scoped. Moving a Memory to another Space does not migrate historical familiarity/affinity learned in the old Space.

### 13.5 Revision continuity

Revision-specific positive evidence is not silently transferred to changed content. Reducers may generalize boundedly across:

- document identity;
- stable SemanticNode lineage;
- unchanged semantic projections;

but retain exact Revision provenance.

### 13.6 Familiarity and forgetting

Familiarity is retrieval-use experience, not truth confidence.

Accessibility is a bounded function of cue/context, familiarity, recency, frequency, explicit negative evidence, semantic continuity, and current time.

Forgetting is computed from elapsed time and real events, not implemented through periodic fake “decay events.” Low accessibility never retires or deletes Authority.

### 13.7 Influence bounds

Adaptive state modifies competition among already admissible/relevant candidates. Exact identity and hard predicates override Adaptive bias. V1 Adaptive state is primarily a bounded reranking/support prior and is not an independent unrestricted candidate generator.

### 13.8 V1 adaptive baseline

Production V1 should implement:

- explicit feedback event log;
- target familiarity;
- simple Tag/query-context-to-target affinity;
- bounded recency/frequency accessibility;
- explicit negative evidence;
- Space scoping;
- deterministic versioned reducers/checkpoints;
- reset and replay.

Research-only until benchmarked:

- adaptive graph edge reinforcement;
- multi-hop path credit assignment;
- adaptive recall seeds;
- learned forgetting curves;
- learned rank fusion/neural personalized retrieval.

### 13.9 Generations and replay

Adaptive mutations advance an independent monotonic `AdaptiveGeneration`. Query pins one Adaptive snapshot for its entire execution.

Checkpoints accelerate startup/rebuild; the event log remains the behavioral history source. Materializers/reducers are versioned.

### 13.10 Purge/reset

Purge physically removes affected managed Adaptive events/materializations through segment rewrite/compaction as necessary. Append-only is the normal write protocol, not a privacy barrier.

Adaptive reset is an explicit operation that clears learned retrieval behavior without altering Memory Authority.

---

## 14. Public TypeScript API

The public SDK is a domain API, not a Rust-internals control panel.

### 14.1 Engine lifecycle

```text
createMemoria(...)
close()
```

One Engine opens one local Store runtime. `close()` is explicit and releases writer ownership/resources without waiting indefinitely for optional background enrichment.

### 14.2 Public domains

Stable surface is organized around:

- engine lifecycle;
- Spaces;
- Memory documents/revisions;
- bounded atomic mutate;
- structured query;
- ReadSession;
- feedback;
- import/export;
- backup/restore;
- status/validation;
- narrowly scoped administration.

Raw index access, manual vector insertion, public planner operator ASTs, arbitrary Tag graph mutation, or experimental algorithm knobs are not V1 stable API.

### 14.3 Document mutation

Expose semantically distinct operations such as create, revise, and semantic patch rather than one blind `put`.

Revision/patch mutations require explicit `expectedHead` optimistic concurrency. SDK never silently retries a semantic patch against a newer HEAD.

Move/retire/restore are topology operations and do not create MDX Revisions.

Irreversible purge lives in administration/governance API rather than ordinary “delete document” ergonomics.

### 14.4 Authoring

TypeScript authoring helpers serialize structured author intent to MDX, but Rust parsing/validation remains canonical. Existing document modification should prefer Rust source-preserving semantic patch operations over round-tripping whole documents through a TypeScript parser/pretty-printer.

### 14.5 Errors

Public errors are stable domain errors, for example:

```text
NOT_FOUND
ALREADY_EXISTS
KEY_CONFLICT
HEAD_CONFLICT
GENERATION_CONFLICT
INVALID_MDX
SEMANTIC_VALIDATION_FAILED
OUT_OF_SCOPE
SNAPSHOT_UNAVAILABLE
CONTINUATION_EXPIRED
CAPABILITY_NOT_READY
PROVIDER_UNAVAILABLE
STORE_LOCKED
STORE_CORRUPT
IDEMPOTENCY_CONFLICT
PURGE_CONFLICT
RESOURCE_LIMIT
UNSUPPORTED_PROFILE
UNSUPPORTED_STORE_FORMAT
ABORTED
QUERY_TIMEOUT
```

Errors carry structured details and retryability semantics instead of leaking SQLite/N-API/OS implementation errors as the primary public contract.

### 14.6 Cancellation

Long operations accept cancellation. Cancellation before Authority commit leaves no Authority mutation; ambiguous races use idempotency and result lookup so callers can determine whether commit occurred.

### 14.7 Query streaming

Final retrieval results are atomic in V1 rather than streamed before fusion/consolidation/reranking has stabilized ordering. Build/status observation may use a separate watch/event interface later.

---

## 15. Rust / N-API Boundary and Provider Host

### 15.1 Coarse-grained ABI

N-API exports coarse request/response protocols, not hundreds of Rust module functions. Conceptual operations include Store open/close, Authority read/mutate, query start/resume, feedback, read-session/snapshot operations, status/admin operations.

The N-API layer is thin: type conversion, async bridging, contiguous buffers, and error mapping only. Core business state remains ordinary reusable Rust code.

### 15.2 Split-phase provider protocol

Rust owns query/build execution until an external provider barrier. It emits typed batched work such as embeddings/rerank/enrichment, TypeScript executes network side effects, and Rust resumes with validated results.

A normal query should require zero, one, or very few coarse crossings, never JS callbacks inside candidate/graph hot loops.

### 15.3 Batch representation

Large vector batches cross the ABI as contiguous typed buffers plus shape metadata, not nested JavaScript `number[][]` structures.

### 15.4 Provider interfaces

Embedding, reranking, and Tag enrichment are distinct provider contracts. They differ in batching, caching, failure, privacy, and semantics and are not collapsed into one generic `LLMProvider` abstraction.

Provider signatures include all output-affecting contract data: provider/model identity, dimension, normalization, task/input mode, reproducibility class, and other relevant options.

Rerank contracts declare pointwise/pairwise/listwise semantics.

### 15.5 Output validation

Provider output is untrusted. Rust validates cardinality, handles, dimensions, finite numeric values, normalization contracts, Tag limits/normalization, and producer/work identity before it can affect Derived state or ranking.

Provider results never directly mutate Authority.

---

## 16. Configuration Model

Configuration is layered rather than one flat algorithm-options object:

- Store/runtime policy;
- Provider configuration;
- retrieval quality policy;
- maintenance/storage policy;
- advanced operational settings;
- experimental research settings.

Stable public configuration describes behavior and operational limits. Internal ANN/Tag Basis/diffusion coefficients are not stable API merely because they exist in an implementation.

Configuration changes are categorized as runtime-changeable, rebuild-required, or format/profile changes. Provider/model/tokenizer changes create replacement Derived generations rather than immediately invalidating the serving generation.

Rust production uses a pinned latest-qualified stable toolchain rather than a floating compiler or nightly requirement. The baseline target at design time is Rust 1.97.1 with edition 2024; any pre-implementation change must be explicitly requalified and pinned.

---

## 17. Physical Storage and Runtime

### 17.1 Plane layout

Conceptual Store layout:

```text
store/
├─ STORE
├─ authority/
│  ├─ authority.sqlite
│  └─ objects/
├─ derived/
│  ├─ catalog.sqlite
│  └─ artifact families...
├─ adaptive/
│  ├─ event/checkpoint metadata
│  ├─ log/
│  └─ materialized/
├─ cache/
└─ runtime/
```

Exact paths/formats are implementation details. `STORE` identifies Store/layout/Authority format.

### 17.2 Single writer, concurrent readers

One active logical writer owner exists per Store in V1. Authority mutations serialize through a short writer domain; queries/readers and background computation run concurrently.

Multiple independent embedded writer processes are unsupported. Future multi-application mutation should be introduced through one local daemon/service that owns the Store rather than pretending filesystem coordination is a distributed system.

### 17.3 Store lock

Writer ownership relies on OS-level locking/lease semantics, not merely presence of a stale `.lock` file. Diagnostic lock metadata may contain PID/runtime information but is not the correctness mechanism.

### 17.4 SQLite role

Authority SQLite stores relational topology/history/transactions. It does not become the vector/text/graph warehouse.

Logical history may have transactionally maintained “current projection” tables/indexes for fast current reads, but these are access paths over Authority history rather than an independently mutable truth source.

Writer transactions are short; parsing, hashing, provider calls, and heavy index computation do not occur while holding the Authority write transaction.

### 17.5 CAS publication

Cross-filesystem/SQLite crash safety follows a safe one-way protocol:

1. hash raw MDX;
2. write/stage CAS object;
3. fsync/durably publish CAS object;
4. begin short Authority transaction;
5. recheck optimistic preconditions;
6. publish Revision/HEAD/state and increment AuthorityGeneration;
7. commit.

Orphan durable blobs are acceptable transient garbage. Authority references to missing non-durable blobs are corruption.

### 17.6 Immutable Derived artifacts

Published Derived artifact files are immutable and preferably mmap-friendly for large packed data. Builders write replacement files/segments separately, validate them, and publish through immutable Manifests.

Artifact files are self-describing with family/format/version/signature/generation/count/integrity metadata.

### 17.7 Leases

ReadSession and continuation leases pin old Manifests/artifacts for bounded TTLs. Query runtime uses active in-process guards/epochs so GC/purge cannot reclaim mappings still being read.

Long-lived logical sessions never depend on OS “open file cannot be deleted” behavior.

### 17.8 GC categories

Keep separate mechanisms for:

- CAS reachability GC;
- Derived artifact/Manifest GC;
- cache eviction;
- Adaptive event/checkpoint compaction/governance;
- runtime/staging cleanup.

CAS GC roots come from retained Authority Revisions and temporary publication/import/backup roots. Derived GC roots come from current Manifest, leases, grace/pins, and build dependencies.

### 17.9 Resource scheduling

Foreground Authority/query work is isolated from background build, compaction, enrichment, and GC. CPU-heavy and I/O-heavy work use appropriate resource pools/backpressure.

When constrained, first evict caches/unmap old artifacts/throttle optional work. Optional enrichment may stop before Authority writes are rejected.

### 17.10 Startup/shutdown

Cold startup performs bounded fast integrity checks, resolves current snapshots/artifacts, recovers interrupted jobs, and starts schedulers. It does not full-scan all CAS, fully verify all hashes, load every vector into heap, or replay all Adaptive events.

`createMemoria()` returns when the Store runtime/Authority is usable; asynchronous Derived readiness is reported through status/capability contracts rather than blocking startup for hours.

Shutdown stops new foreground work, safely suspends/cancels optional background jobs, persists required queue/control state, releases mappings/leases, and releases writer lock without waiting for all backlog to complete.

### 17.11 Filesystem assumptions

Live V1 Stores require a suitable local filesystem with supported SQLite locking and ordinary durable rename/fsync semantics. Active Stores in generic network shares or directory-sync products are not a supported replication/concurrency mechanism.

Windows, Linux, and macOS behavior for locking, atomic publication, mmap lifetime, rename/delete, and crash recovery must be tested from the first implementation phase.

---

## 18. Backup, Export/Import, Recovery, and Purge

### 18.1 Backup versus export

Backup/restore preserves one Store identity universe: same StoreId, SpaceIds, MemoryIds, RevisionIds, DAG, and source blobs.

Export/import is portable transfer. Import creates new local Space/Memory/Revision identity by default, rewrites package-internal references through a deterministic remap table, preserves origin identities as provenance, and requires explicit mappings for unresolved external references.

Import never automatically merges based on semantic hash or origin identity.

### 18.2 Backup snapshot

Backup pins one Authority snapshot, captures a consistent Authority DB image, enumerates all reachable CAS blobs, and emits an integrity manifest.

Default user-facing backup should preserve Authority + CAS + Adaptive experience. Derived/cache are excluded by default because they are rebuildable. An Authority-only minimal backup remains useful.

Backup must not silently reduce encryption/confidentiality.

### 18.3 Restore

Restore is logically an offline replacement operation. It stages, verifies manifest/DB/CAS reachability/hashes, and activates only after validation. A failed restore does not partially overwrite an active valid Store.

### 18.4 Recovery classes

- Derived corruption: isolate invalid artifacts, fall back/degrade if possible, rebuild from Authority;
- Adaptive materialization corruption: rebuild from events;
- repairable Authority access projection corruption: rebuild projection from retained Authority history;
- missing Source CAS referenced by Authority or missing authoritative DAG topology: Authority corruption, never guessed from similar Derived text.

### 18.5 Purge

Purge is planned governance, not `DELETE FROM memory`.

It must account for Authority revisions/blob reachability, inbound references, Derived structures, Entity observations, Tag/graph evidence, Adaptive events/materializations, caches/receipts, and active snapshot leases.

Purge follows “logical inaccessibility first, physical reclamation after safe reader epoch.” Crash recovery resumes incomplete physical cleanup.

The operation state belongs to a PurgeOperation (`planned/committed/cleaning/completed` conceptually), not a permanent normal Memory lifecycle value.

Purge may revoke affected ReadSessions/continuations; privacy deletion takes precedence over old computational reproducibility.

### 18.6 Referential purge versus scrub

A standard referential purge can remove the target Memory and all managed information owned by that identity while old retained Authority in other Memories may still contain an opaque inbound reference that now resolves as purged/unresolved.

If the caller requires removal of those references or textual mentions from other retained Authority, that is a broader explicit referential/content scrub plan involving new revisions and/or further purges. Memoria never silently rewrites retained historical Authority.

Managed Store purge cannot guarantee deletion from external exports/backups that are outside its managed storage, nor forensic secure erase on arbitrary SSD/COW/snapshot environments.

---

## 19. Host Integration and Agent Skill Contract

### 19.1 Long-term memory versus conversation log

Raw chat messages remain Host events. Memoria stores curated long-term aggregated semantic MemoryDocuments.

Most conversation turns should result in `NO-OP`, not a Memory mutation.

### 19.2 Memory authoring policy

Before writing, Host/Agent determines:

1. whether the information is long-lived;
2. likely Space;
3. stable EntityRefs and resolved time/reference context;
4. whether an existing MemoryDocument owns the topic;
5. whether the operation is create/add/update/transition/correct/no-op;
6. whether a semantic Patch can make the minimal change;
7. source provenance;
8. expected HEAD and concurrency safety.

New information preferentially updates a long-lived topic-owning MemoryDocument instead of creating one short document per utterance.

A search miss never automatically implies create.

### 19.3 Stable references are discovered, not invented

Agent/Host receives IDs through context, directories, catalog discovery, query results, or create results. It does not fabricate EntityRef, MemoryId, RevisionId, or an existing SemanticNodeId from a display name.

### 19.4 Referential Closure

Host resolves conversational references while preserving epistemic meaning. “I might go to Japan next year” does not become “X will go to Japan next year”; it becomes an explicit identity/time-aware statement that retains uncertainty.

### 19.5 Transition versus correction

A world-state change is recorded as transition/history, preserving old valid state. A correction records that earlier knowledge/representation was wrong. Ordinary Revision editing does not collapse this distinction.

### 19.6 Minimal mutation

Daily Agent maintenance prefers typed semantic patches over full-document rewrites. Full revisions are reserved for explicit broad restructuring/import/manual editing.

HEAD conflicts cause reread/reason/rebuild of the intended mutation; SDK/Skill never blindly substitutes the new HEAD and retries the same patch.

### 19.7 Recall workflow

Host decides when long-term memory is needed, resolves entities/time/scope, builds a referentially explicit structured query, consumes multiple MemoryResults as evidence, performs final reasoning, and submits explicit feedback after actual use/judgment.

Association evidence is discovery/support, not causal proof.

### 19.8 External authorities

Live external systems remain authoritative for their own current structured state. Memoria may supply long-term context and provenance but must not override fresh GitHub/Calendar/task/database facts merely because an older Memory says otherwise.

### 19.9 Agent Tool adapter

Agent-facing tools are narrower than the developer SDK and use intent-oriented operations such as find/read/update/correct/record/forget/find-entity/list-spaces. The wrapper constrains side effects but does not hide another opaque memory agent that silently resolves identity, merges content, and commits Authority.

Read, write, feedback, lifecycle, purge, export, and administrative capabilities are permissioned separately by the Host.

### 19.10 Feedback timing

Feedback follows answer/evidence use. Retrieval Q pins Adaptive generation N; post-answer feedback creates N+1 and cannot alter the query that produced it.

---

## 20. Security, Privacy, and Trust Boundaries

### 20.1 Threat classes

Design assumes risks from local at-rest disclosure, compromised runtime/plugins, external Provider data egress, prompt injection/memory poisoning, and logical authorization/scope bugs.

### 20.2 Data is not instruction

User messages, retrieved Memory, Quote, Source, external documents, and provider outputs are untrusted data/evidence. They never become current authorization or system instruction merely because they are stored/retrieved.

Memories may describe past instructions; they do not authorize destructive operations now.

### 20.3 Declarative parsing

Parsing Authority never executes code. Unknown Extensions never trigger runtime loading, network access, dependency installation, or code execution.

### 20.4 Scope and authorization

Space is not an ACL, but every catalog/discovery/query/entity-observation operation is scope-aware. Host authorization determines which Spaces/actions an Agent may use, and Memoria scope semantics provide a second deterministic containment layer.

Out-of-scope relation/entity/catalog information is not exposed merely through counts, titles, or diagnostics.

### 20.5 Sensitive Derived/Adaptive/cache data

Vectors, Tags, graphs, Entity observations, cached provider views, and Adaptive behavior can leak private information. Rebuildability is a durability property, not a confidentiality property.

### 20.6 Provider data egress

Embedding, reranking, and enrichment have independently controllable data-egress policies. Policies may vary by Space/security scope and are checked before work leaves the trusted boundary.

Projection minimization sends only task-required text/context and omits opaque IDs/provenance/internal metadata by default, but visible text may still contain PII; absence of EntityRef is not anonymization.

Provider routing never silently falls back to another service with different data policy/model signature.

Privacy policy outranks requested retrieval quality: forbidden external provider use results in permitted degradation or explicit capability failure.

### 20.7 At-rest encryption architecture

Store-level at-rest encryption is an architectural capability, covering all managed sensitive planes rather than Authority alone. The cryptographic implementation is selected from mature primitives/libraries during implementation research.

Logical hashes/IDs are computed from logical plaintext/canonical content, not ciphertext, so key rotation/re-encryption does not alter Memory/Revision identities.

Encryption-at-rest protects offline storage/backup scenarios but does not claim protection from an already compromised unlocked Host process.

### 20.8 Logging/telemetry

Production logs/diagnostics do not dump full MDX/provider inputs/raw query text by default. Prefer IDs, hashes, counts, latencies, versions, and bounded excerpts where necessary.

Retrieval receipts and diagnostic traces have bounded retention and must not become accidental secondary long-term Memory stores.

### 20.9 Imports and untrusted native boundaries

Import packages, N-API data, provider results, and MDX are resource-bounded and structurally validated. Defenses cover depth, input size, node/tag/relation counts, dimensions, NaN/Inf, archive traversal, decompression/resource bombs, and malformed topology.

Rust memory safety does not remove the need to minimize/encapsulate `unsafe`, FFI, mmap, ANN native dependencies, and supply-chain risk.

### 20.10 Deletion semantics

Correction/transition preserves history. Privacy erasure requires purge/scrub. Purge reports managed removal, inbound retained references/shared CAS constraints, and cleanup completion honestly rather than claiming forensic secure erase or deletion of unmanaged external copies.

Security/privacy governance may invalidate old ReadSessions and historical computational reproducibility.

---

## 21. Testing and Verification Strategy

Implementation must treat invariants as executable tests, not prose only.

### 21.1 Authority properties

Property/invariant tests cover:

- every Revision references a durable existing SourceBlob;
- Revision ownership and parent ownership;
- DAG acyclicity;
- HEAD belongs to its Memory;
- at most one effective DocumentState per generation;
- one Space membership per effective Memory state;
- `(SpaceId, DocumentKey)` uniqueness;
- one generation advancement per committed atomic mutation;
- failed batches publish no partial Authority;
- idempotency replay/conflict semantics;
- no staged-only CAS object becomes an Authority reference.

### 21.2 Compiler/invalidation tests

Golden/property tests verify deterministic MDX parse/lowering, source-preserving patches, SemanticHash behavior, semantic-node lineage, and an explicit invalidation matrix for formatting/text/entity/tag/time/relation/source changes.

Provider-call-count tests must prove that formatting-only or temporal-only changes do not accidentally trigger expensive embeddings/enrichment when their projection inputs are unchanged.

### 21.3 Snapshot and crash testing

Crash/fault-injection tests cover failures at CAS staging/publication, SQLite pre/post commit, artifact build/validation/Manifest publication, Adaptive checkpoint publication, backup staging/activation, and purge cleanup.

Every persistence plane follows the common rule: construct -> validate -> publish pointer last.

### 21.4 Retrieval benchmarks

Build a representative memory corpus and evaluate at least:

- lexical-only;
- vector-only;
- lexical + vector;
- Tag association;
- Tag Basis + Residual;
- Activation versus Diffusion;
- Relation expansion;
- hierarchical versus flat retrieval;
- reranker on/off;
- Adaptive on/off.

Track Recall@K, MRR/nDCG or equivalent ranking measures, diversity, duplicate-evidence rate, latency, memory/disk usage, graph visits, provider calls/cost, incremental-update cost, and startup/maintenance interference.

Tag Basis/Residual and old propagation ideas survive as hypotheses to validate, not as sacred implementation requirements.

### 21.5 Adaptive-specific tests

Evaluate:

- rich-get-richer/self-reinforcement rate;
- recovery after explicit negative feedback;
- stale-memory persistence;
- cross-Space contamination;
- revision carryover error;
- cue overfitting;
- long-tail starvation;
- reset/replay equivalence.

### 21.6 Platform tests

Windows, Linux, and macOS tests cover file locking, atomic publication/rename, SQLite/WAL behavior, mmap lifetime, deletion after leases, crash recovery, and native packaging.

### 21.7 Security tests

Fuzz/resource-limit tests cover MDX, imports, extension payloads, N-API buffers, provider result shapes/numerics, and query/mutation request limits. Scope/authorization adapter tests confirm that catalog/entity/status side channels do not disclose out-of-scope information.

---

## 22. Open Research and Engineering Decisions

The following are intentionally **not** frozen by this architecture. Each must be resolved by a focused benchmark/prototype or normative sub-spec before the dependent implementation is considered stable.

### 22.1 Storage and binary formats

- exact SQLite history/current-projection table layout;
- CAS digest algorithm/encoded length and loose-object versus future packing thresholds;
- immutable lexical/vector/graph segment formats;
- mmap structures and compaction thresholds;
- whether Adaptive event storage begins as SQLite-backed append tables, segment files, or a hybrid.

### 22.2 MDX normative profile

- exact element names and literal attribute grammar;
- exact initial closed Relation kind set and behavior matrix;
- exact typed patch operation surface;
- exact temporal literal/boundary normalization rules;
- exact Extension handler ABI.

The semantic roles and safety boundaries in this document are fixed; only normative surface details remain.

### 22.3 Retrieval algorithms

- ANN library/index strategy;
- Chinese/multilingual lexical tokenizer implementation;
- exact multi-resolution materialization policy;
- parent-vector provider embedding versus pooled child-vector strategies;
- Tag Basis numerical method and quality thresholds;
- Activation/Diffusion parameters and operator-selection rules;
- association evidence weighting/normalization;
- fusion baseline/calibration;
- propagation support/structure features;
- historical hot/cold retrieval materialization.

### 22.4 Adaptive algorithms

- exact saturating familiarity function;
- recency/frequency weighting;
- negative feedback propagation;
- cue/tag affinity representation;
- long-term event retention/compaction sufficient statistics;
- whether/when experimental adaptive candidate seeds graduate into serving.

### 22.5 Security implementation

- at-rest encryption primitives and key-management UX;
- encrypted mmap/page strategy;
- backup-key wrapping and restore workflow;
- exact data-egress policy enums/classes;
- local-daemon trust/isolation model if introduced later.

### 22.6 Toolchain and native dependencies

Policy is pinned latest-qualified stable Rust, edition 2024, stable-only production, with N-API as a thin binding layer. Exact native dependencies (including NAPI-RS generation, ANN/index libraries, parser components, mmap/crypto helpers) require current primary-source review and qualification during implementation planning.

---

## 23. Implementation Decomposition

This document is an umbrella architecture. Implementation should not be attempted as one undifferentiated rewrite. The subsequent implementation plan should decompose work into dependency-ordered slices with runnable verification at each boundary.

Recommended order:

1. **Foundation / Store runtime** — new Rust workspace, toolchain pin, Store layout, writer lock, Authority SQLite/CAS transaction skeleton, typed public IDs/errors, minimal TS/N-API boundary.
2. **Authority model** — Store/Space/Memory/Revision DAG/HEAD/DocumentKey/lifecycle/generation/idempotency/atomic batch/read snapshots.
3. **MDX Profile + lossless parser + Canonical IR** — normative profile sub-spec first, validator, source mapping, SemanticHash, semantic patch core.
4. **Local Base Derived compiler** — IR persistence/catalog, semantic diff, dependency graph, structural/lexical/temporal/relation/entity/explicit-Tag artifacts, Manifest publication, BaseReady.
5. **Structured Query baseline** — scopes, cues/constraints, snapshot/consistency contract, exact/lexical/temporal/structural retrieval, result consolidation and receipts.
6. **Provider protocol + semantic vectors** — split-phase embedding Provider Host, cache signatures, vector payload/index generations, semantic capability.
7. **Tag association retrieval** — Tag dictionary/membership/evidence graph, Tag vectors, Basis/Residual experiment, bounded Activation/Diffusion, propagation evidence.
8. **Reranking + Recall Assessment** — provider contract, deterministic views, final evidence/assessment separation.
9. **Adaptive V1** — feedback receipts/events, generation/checkpoints, bounded familiarity/affinity, replay/reset/purge-safe storage.
10. **Backup/import/export/purge/recovery** — snapshot backup/restore, portable remap import/export, GC, integrity/fault recovery, governance.
11. **Security/privacy hardening** — Provider policies, encryption implementation, logging/retention, import/native fuzzing, Agent-safe tool adapter.
12. **Heptalogos adapter + Agent Skill** — identity/context integration, authoring/retrieval workflows, permission-limited tools, feedback lifecycle.
13. **Performance and algorithm qualification** — cross-platform scale benchmarks, maintenance interference, provider-cost benchmarks, ablations, compaction tuning.

Each slice must keep previous serving behavior testable rather than building the entire architecture before the first end-to-end executable path exists.

---

## 24. Architecture Acceptance Criteria

The architecture is successfully represented in implementation when all of the following are true:

1. A Memory write can commit durable raw MDX Authority without any external Provider and survives crash/reopen.
2. Deleting/rebuilding Derived leaves Authority intact and produces equivalent logical Base retrieval.
3. Querying requires explicit scope and uses Host-resolved EntityRefs/time/history semantics.
4. A query can pin Authority/Derived/Adaptive snapshot identities and never mixes unpublished artifact state.
5. A temporal-only or Tag-only semantic edit avoids unrelated embedding recomputation by dependency contract.
6. External Provider failure cannot roll back Authority or block local BaseReady.
7. Query returns multiple revision-pinned MemoryResults with consolidated matches rather than flat anonymous chunks.
8. Tag association/propagation never becomes an authoritative Relation or identity-resolution mechanism.
9. Explicit Host feedback is the only source of durable Adaptive learning, and Adaptive reset restores static retrieval behavior.
10. Space move preserves Memory identity/history but does not transfer Space-local adaptive evidence.
11. Concurrent stale write attempts produce explicit HEAD/generation conflicts rather than silent overwrite.
12. Purge removes managed target Authority/Derived/Adaptive/cache state and may explicitly invalidate snapshot leases, without pretending to rewrite unrelated retained history.
13. Agent-facing tools cannot invent stable identities, bypass expected-head semantics, or treat retrieved content as current authorization.
14. Sensitive Spaces can remain usable with provider-dependent capabilities disabled.
15. Windows/Linux/macOS crash/lock/publication behavior passes the same persistence invariants.

---

## 25. Final Design Summary

Memoria Next should be understood as:

> **A local embedded, generation-versioned semantic memory authority with an incremental compiler and deterministic retrieval runtime.**

Its primary data path is:

```text
Host resolves language/identity/authoring intent
        ↓
Restricted MDX Authority
        ↓
Rust parse / validate / CAS + Authority commit
        ↓
Canonical Memory IR
        ↓
capability-specific incremental Derived artifacts
        ↓
immutable Derived Manifest
        ↓
structured query + pinned Authority/Manifest/Adaptive snapshot
        ↓
exact / lexical / semantic / Tag / relation / historical operators
        ↓
evidence fusion + hierarchical consolidation + optional rerank
        ↓
revision-pinned retrieval evidence + Recall Assessment
        ↓
Host reasoning / answer
        ↓
explicit feedback only
        ↓
Adaptive event and bounded recall learning
```

The architecture deliberately refuses several tempting shortcuts: raw chat as memory, names as identity, executable MDX, query-time LLM interpretation, one universal vector pipeline, blind `remember(text)`, silent merge/overwrite, automatic Top-K reinforcement, and conflating forgetting with deletion.

Those refusals are not limitations to be patched around; they are the boundaries that make the system evolvable, testable, and suitable for long-running autonomous interaction.