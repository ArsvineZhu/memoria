# Memoria Engine Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 将 Memoria 整理为独立、宿主无关、ESM-first 的原生 TypeScript Node.js memory engine，同时保留现有算法、SQLite schema 兼容性、filesystem 兼容层与 Rust N-API ABI。

**Architecture:** MemoryEngine 的主领域输入是带稳定 logical identity 的 MemoryDocumentInput；filesystem 读取、扫描和 watcher 只存在于 adapter。SQLite metadata/content 是权威状态，Vexus/Rust 索引是可重建派生状态；引擎启动时能检测并重建派生索引。公共包采用 src/index.ts -> dist/ 的 NodeNext ESM 构建，Rust 生成 loader 保留在独立 CommonJS package scope 内。

**Tech Stack:** Node >=24.18.1 <25, pnpm 11.20.0, TypeScript 7.0.2, @types/node 24.13.3, ES2024, NodeNext, Prettier 3.9.6, Oxlint 1.77.0, node:test, better-sqlite3, chokidar, Rust N-API generated loader。

## Global Constraints

- 不引入任何 @heptalogos/* dependency 或 runtime contract。
- 不修改 Rust 算法思想、N-API exported symbols 或 generated rust-vexus-lite/index.js 的业务内容。
- noUncheckedIndexedAccess 最终开启；不得用批量非空断言消除数值代码错误。
- SQLite 现有 files/chunks/tags/file_tags/kv_store 数据格式必须可继续打开；新增字段必须通过可重复 migration 增加。
- 不实现 ESM+CJS dual package，除非仓库审计证明存在真实外部 CommonJS consumer；最终报告必须说明 breaking change。
- 保留 flushBatch、handleDelete、KnowledgeBaseAdapter 等 compatibility API，内部逐步桥接到 logical ingestion。
- 每个生产行为改动先写 failing node:test，再实现最小代码；工具配置、纯文件重命名和生成文件除外。
- 最终验证必须覆盖 format、lint、typecheck、test、build、native load、packed clean consumer、Windows 与 Linux native smoke。

---

### Task 1: Baseline audit and repository guardrails

**Files:**

- Create: docs/superpowers/plans/2026-08-09-memoria-engine-remediation.md
- Modify: README.md, docs/ARCHITECTURE.md, docs/PERSISTENCE.md only when audit findings require factual corrections
- Test: tests/core/test-public-api.test.ts, new tests/core/test-package-boundary.test.ts

**Interfaces:**

- Consumes: existing public export surface and current SQLite/native smoke tests.
- Produces: a repeatable baseline/verify command set and explicit inventory of remaining CommonJS, npm-only, and unverified package claims.

- [x] Record current Node, package-manager, typecheck, build, public typecheck, native, full test, and pack results.
- [x] Read the Heptalogos rewrite branch package.json, pnpm-workspace.yaml, tsconfig.base.json, rewrite/STATUS.md, rewrite/README.md, and latest commit.
- [ ] Add a built-package boundary test that keeps internal SQLite/N-API loader paths out of the public API.
- [ ] Run the focused boundary tests before moving to package changes.

### Task 2: Toolchain and package boundary alignment

**Files:**

- Modify: package.json, tsconfig.base.json, tsconfig.build.json, tsconfig.test.json, tsconfig.public.json, .gitignore, .github/workflows/ci.yml
- Create: pnpm-lock.yaml, prettier.config.mjs, oxlint.json
- Delete: package-lock.json after the pnpm lockfile is generated and validated
- Move: index.ts to src/index.ts
- Test: tests/core/test-public-api.test.ts, tests/types/public-api.test-d.ts, new tests/consumer/test-esm-consumer.test.ts

**Interfaces:**

- Produces: type module, explicit exports, src -> dist, declarations, source maps, pnpm scripts, and a CJS-scoped native loader package.

- [ ] Write an ESM consumer test that imports dist/index.js, opens an in-memory engine with a fake provider, ingests, searches, deletes, and closes.
- [ ] Run pnpm build:test and the consumer test; confirm the current CommonJS package fails for the intended boundary reason.
- [ ] Set target/lib to ES2024, module/moduleResolution to NodeNext, enable noImplicitOverride, noUncheckedIndexedAccess, noUncheckedSideEffectImports, verbatimModuleSyntax, isolatedModules, and add the pinned packageManager.
- [ ] Add format, format:check, lint, typecheck, test, build, verify:public, and verify:pack scripts.
- [ ] Set the root package to ESM, publish dist/index.js and dist/index.d.ts through exports["."], move the public source entry to src/index.ts, and include rust-vexus-lite/package.json in the tarball.
- [ ] Set rust-vexus-lite/package.json to type commonjs without editing the generated loader.
- [ ] Generate pnpm-lock.yaml with pnpm 11.20.0, run pnpm install --frozen-lockfile, and remove package-lock.json.
- [ ] Convert hand-written TS imports/exports to native ESM with .js relative specifiers; use createRequire(import.meta.url) only at the N-API facade.
- [ ] Run format check, lint, typecheck, build, test, and the ESM consumer test.

### Task 3: Host-agnostic logical ingestion

**Files:**

- Modify: src/types.ts, src/engine.ts, src/core/context.ts, src/stages/ingestion/file-reader.ts, src/stages/ingestion/metadata-writer.ts, src/stages/ingestion/file-deleter.ts, src/providers/sqlite-metadata-store.ts, src/interfaces/metadata-store.ts, src/stages/output/result-formatter.ts, src/config/default-config.ts
- Create: tests/engine/test-logical-ingestion.test.ts, tests/providers/test-logical-metadata.test.ts

**Interfaces:**

- MemoryDocumentSource { type?: string; uri?: string; path?: string; collection?: string; [key: string]: unknown }
- MemoryDocumentInput { id: string; content: string; source?: MemoryDocumentSource; revision?: string | number; metadata?: UnknownRecord; createdAt?: number; updatedAt?: number }
- MemoryEngine.ingest(document | readonly document[]): Promise<IngestEnvelope | IngestEnvelope[]>
- MemoryEngine.upsert(document | readonly document[]): Promise<IngestEnvelope | IngestEnvelope[]>
- MemoryEngine.remove(reference: string | { id: string; revision?: string | number }): Promise<DeleteEnvelope>

- [ ] Write tests proving path-free ingest/search, same-id and same-revision idempotency, newer-revision replacement, logical-id deletion, source/metadata persistence after SQLite reopen, and batch envelope count.
- [ ] Run the logical suites in red and ensure failures identify the missing contract rather than test setup.
- [ ] Add the logical types and a pure normalizeMemoryDocument helper. A document without a filesystem source must never call fs; derive a deterministic storage key from id and a revision from the explicit value or content checksum.
- [ ] Add nullable document_id, revision, source_json, and metadata_json columns through idempotent SQLite migration, add a partial unique index for document_id, and extend the metadata port with getFileByDocumentId and typed JSON parse/serialize guards.
- [ ] Make FileReaderStage accept a supplied logical snapshot without disk access, compare document_id/revision before legacy path/checksum rules, and make MetadataWriterStage persist source, metadata, and revision while retaining legacy file behavior.
- [ ] Implement ingest, upsert, and remove. Keep flushBatch and handleDelete as explicit filesystem compatibility methods.
- [ ] Run the logical suites, typecheck, and the existing full test suite.

### Task 4: Filesystem adapter boundary

**Files:**

- Create: src/adapters/filesystem-ingestion-adapter.ts, tests/adapters/test-filesystem-ingestion-adapter.test.ts
- Modify: src/index.ts, src/engine.ts, README.md, docs/GUIDE.md, docs/API.md, docs/ARCHITECTURE.md
- Keep: src/compat/knowledge-base-adapter.ts as a compatibility surface

**Interfaces:**

- FilesystemIngestionAdapter.ingestPath(path), ingestPaths(paths), scan(), removePath(path), and watch() returning a disposable watcher.
- The adapter owns fs, path normalization, extension filtering, and optional chokidar watcher; MemoryEngine owns logical identity and persistence.

- [ ] Write tests with two supported files and one ignored extension; assert scan, removePath, and watcher close behavior.
- [ ] Run the adapter test in red.
- [ ] Read files in the adapter, compute a SHA-256 revision, construct a filesystem MemoryDocumentInput with type/path/uri/collection, and call only engine.ingest/remove.
- [ ] Run adapter, engine, compatibility, and full tests; update docs so logical ingestion is primary and flushBatch is compatibility.

### Task 5: Authority, reconciliation, lifecycle, and structured errors

**Files:**

- Create: src/errors.ts, src/reconciliation.ts, tests/engine/test-recovery-and-lifecycle.test.ts, tests/core/test-errors.test.ts
- Modify: src/engine.ts, src/providers/vexus-vector-store.ts, src/interfaces/vector-store.ts, src/providers/sqlite-metadata-store.ts, src/types.ts, src/config/default-config.ts, src/stages/ingestion/vector-indexer.ts, src/stages/ingestion/file-deleter.ts

**Interfaces:**

- MemoriaError { code: MemoriaErrorCode; retryable: boolean; cause?: unknown }
- MemoryEngine.reconcile(): Promise<ReconciliationReport>
- VectorStoreContract.rebuild?(entries: readonly RebuildVectorEntry[]): Promise<void>
- ReconciliationReport { rebuiltIndices: string[]; indexedVectors: number; staleState: boolean; issues: string[] }

- [ ] Write tests for metadata commit followed by vector failure, stale/deleted vectors after reopen, replacement failure, batch interruption, idempotent close, failed initialize cleanup, and scheduled native-save drain.
- [ ] Write error tests for configuration, persistence, embedding, native, retrieval, integrity, and lifecycle codes; messages must not contain API keys or document content.
- [ ] Implement a small stable error-code union and boundary wrapping helpers without changing internal algorithm semantics.
- [ ] Implement VexusVectorStore.rebuild(entries) by cancelling timers, creating fresh native indices, restoring metadata vectors, and scheduling durable saves.
- [ ] Implement MemoryEngine.reconcile() over authoritative SQLite chunks/tags and run it during initialize before onReady.
- [ ] Guard initialize and close so partial failures clean up, timers drain, and close is idempotent.
- [ ] Run focused recovery/error suites, native tests, typecheck, build, and full tests.

### Task 6: Numerical safety hardening

**Files:**

- Modify: src/algorithms/epa.ts, src/algorithms/gram-schmidt.ts, src/algorithms/residual-pyramid.ts, src/algorithms/svd.ts, src/algorithms/wave-propagation.ts, src/algorithms/topology/scaled-field-solver.ts, and related memo stages
- Create: tests/algorithms/test-numerical-safety.test.ts

**Interfaces:**

- No algorithm output shape changes; invalid dimensions and non-finite inputs produce deterministic typed errors or documented empty envelopes.

- [ ] Write tests for empty input, dimension mismatch, zero/near-zero vectors, NaN, Infinity, singular/rank-deficient matrices, duplicate vectors, extreme magnitudes, one-dimensional data, and malformed matrices.
- [ ] Run the edge-case suite in red and record each unhandled failure.
- [ ] Add checked vector/matrix dimension and finite-number helpers, use bounds-aware access under noUncheckedIndexedAccess, and return existing skip/empty semantics where established.
- [ ] Run all algorithm/memo tests and then the full suite.

### Task 7: Native distribution and packed consumer

**Files:**

- Create: tests/consumer/test-packed-consumer.mjs, scripts/verify-packed-consumer.mjs, docs/NATIVE-MATRIX.md
- Modify: package.json, rust-vexus-lite/package.json, README.md, docs/TROUBLESHOOTING.md, .github/workflows/ci.yml
- Keep: generated rust-vexus-lite/index.js, rust-vexus-lite/index.d.ts, and existing .node files

**Interfaces:**

- Packed consumer flow: pack -> clean temp dir -> install tgz -> ESM import -> initialize -> logical ingest -> search -> delete -> native smoke -> close.

- [ ] Write the packed-consumer verifier and assert the nested CJS loader plus Vexus index load without Rust/Cargo.
- [ ] Run it in red against the current package.
- [ ] Implement the clean consumer and platform report; only claim triples represented by actual tarball files.
- [ ] Run pack, native, and the clean consumer on Windows; CI must repeat native smoke on Ubuntu and Windows.

### Task 8: Docs, CI, final gates, and commits

**Files:**

- Modify: README.md, CHANGELOG.md, docs/GUIDE.md, docs/API.md, docs/ARCHITECTURE.md, docs/PERSISTENCE.md, docs/EMBEDDING.md, docs/TROUBLESHOOTING.md, docs/FUNCTIONS.md, .github/workflows/ci.yml
- Create: docs/RELEASE-CHECKLIST.md

**Interfaces:**

- Documentation describes implemented ESM API, logical ingestion, filesystem adapter, SQLite authority, reconciliation, lifecycle, native matrix, and actual test counts; deferred work is explicitly labeled not completed.

- [ ] Replace npm-only development commands with pinned pnpm commands, use final ESM imports and .js runtime paths, and make logical ingestion the primary example.
- [ ] Update CI to Node 24.18.1, pnpm 11.20.0, frozen install, format check, Oxlint, typecheck, build, node:test, public types, packed consumer, and native smoke.
- [ ] From the current tree run pnpm install --frozen-lockfile, pnpm format:check, pnpm lint, pnpm typecheck, pnpm build, pnpm test, pnpm verify:public, pnpm verify:pack, and git diff --check; inspect the actual tarball and final status.
- [ ] Commit independently reviewable stages for toolchain/ESM, logical ingestion/adapter, reliability, numerical/native hardening, and docs/CI. Do not commit dist, dist-test, or temporary tarballs.
