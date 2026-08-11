# MDX Data Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `data/` the default durable boundary, use MDX front matter as structured source metadata, and migrate/clean known generated data without touching the evaluation corpus.

**Architecture:** Add a public `dataPath` configuration root that derives the main and TDB source/state paths unless explicit legacy overrides are supplied. Parse leading YAML front matter in the ingestion reader, pass the body to the existing chunk/embed chain, merge structured metadata into the existing JSON columns, and merge front-matter tags through the existing tag normalization rules. Rebuild generated demo state under `data/` and remove only verified orphan cache directories.

**Tech Stack:** TypeScript/ESM, Node `node:test`, `better-sqlite3`, Vexus/usearch, `yaml` for YAML front matter, Corepack pnpm, PowerShell filesystem operations.

## Global Constraints

- Preserve the public `SearchResult` shape and existing `MemoryDocumentInput` semantics.
- Do not add SQLite tables, persistence interfaces, Rust bindings, VCP, or a second content authority.
- Keep `sourcePriority.associate` as a source weight; `associateCount` remains the association limit.
- Preserve `eval/` and its benchmark data exactly; do not migrate or delete it.
- Preserve unrelated existing worktree changes, including the prior geodesic/associator implementation; only touch overlapping files for this objective.
- MDX is parsed as UTF-8 text; JSX/import/export is never executed.
- `:memory:` remains a supported explicit test mode, but no longer is the default for main or TDB persistence.
- Every production behavior change follows RED → GREEN → REFACTOR with a targeted test run before broader verification.

---

### Task 1: Add the managed data-path contract

**Files:**

- Modify: `src/types.ts:28-33` to add `dataPath` to `MemoryConfig`.
- Modify: `src/config/default-config.ts:23-27,192-199,227-241` to derive main/TDB paths from `dataPath` and preserve explicit path overrides.
- Modify: `src/engine.ts:154-158` so explicit top-level `options.dbPath` always overrides the merged config.
- Modify: `src/providers/sqlite-metadata-store.ts:1-5,158-176` to create a parent directory for file-backed databases.
- Modify: `src/tdb/tdb-store.ts:1-5,124-139` to create a parent directory for file-backed TDB databases.
- Modify: `.gitignore` to ignore generated `data/memoria/`, `data/tdb/`, SQLite WAL/SHM, and temporary index sidecars while keeping `data/content/**/*.mdx` trackable.
- Test: `tests/engine/test-engine.test.ts` and `tests/tdb/test-tdb.test.ts`.

**Interfaces:**

- Consumes: `MemoryConfigOverrides`, existing explicit `rootPath`/`storePath`/`dbPath`/TDB overrides.
- Produces: `DEFAULT_CONFIG.dataPath`, default paths under `data/`, and `mergeConfig({ dataPath })` path derivation.

- [ ] **Step 1: Write failing path/config tests**

Add assertions that:

```ts
assert.equal(DEFAULT_CONFIG.dataPath, join(process.cwd(), "data"));
assert.equal(DEFAULT_CONFIG.rootPath, join(DEFAULT_CONFIG.dataPath, "content"));
assert.equal(
  DEFAULT_CONFIG.storePath,
  join(DEFAULT_CONFIG.dataPath, "memoria", "indexes"),
);
assert.equal(
  DEFAULT_CONFIG.dbPath,
  join(DEFAULT_CONFIG.dataPath, "memoria", "memory.sqlite"),
);
assert.equal(DEFAULT_CONFIG.tdbRootPath, join(DEFAULT_CONFIG.dataPath, "knowledge"));
assert.equal(
  DEFAULT_CONFIG.tdbStorePath,
  join(DEFAULT_CONFIG.dataPath, "tdb", "indexes"),
);
assert.equal(
  DEFAULT_CONFIG.tdbDbPath,
  join(DEFAULT_CONFIG.dataPath, "tdb", "knowledge.sqlite"),
);

const custom = mergeConfig({ dataPath: join(tmpdir(), "custom-data") });
assert.equal(custom.rootPath, join(custom.dataPath, "content"));
assert.equal(custom.storePath, join(custom.dataPath, "memoria", "indexes"));
assert.equal(custom.dbPath, join(custom.dataPath, "memoria", "memory.sqlite"));
const legacy = mergeConfig({
  dataPath: "custom",
  rootPath: "legacy-root",
  dbPath: ":memory:",
});
assert.equal(legacy.rootPath, "legacy-root");
assert.equal(legacy.dbPath, ":memory:");
```

Add a provider test that constructs `SqliteMetadataStore` and `TDBStore` with a nested file path whose parent does not exist, then asserts both databases open and close successfully.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
corepack pnpm test -- tests/engine/test-engine.test.ts tests/tdb/test-tdb.test.ts
```

Expected: failures for missing `dataPath`, old default paths, and missing parent-directory creation.

- [ ] **Step 3: Implement path derivation and parent creation**

Use a `DEFAULT_DATA_PATH` constant in `default-config.ts`. In `mergeConfig`, track which path keys were explicitly supplied; when `dataPath` is supplied, derive only the path keys not supplied by the caller. Add `mkdirSync(dirname(dbPath), { recursive: true })` for non-`:memory:` paths in both SQLite providers. Keep explicit top-level `options.dbPath` authoritative.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the same command. Expected: all focused engine/TDB tests pass.

- [ ] **Step 5: Refactor without changing behavior**

Keep path derivation in one small helper inside `default-config.ts`; do not add a new persistence abstraction for directory creation.

### Task 2: Implement and test the MDX front-matter parser

**Files:**

- Modify: `package.json` and `pnpm-lock.yaml` to add `yaml`.
- Create: `src/utils/mdx-document.ts` with `parseMdxDocument(content: string)` and exported `MdxDocument`/`MdxFrontmatter` types.
- Modify: `src/index.ts` to export the parser and its public types if they are part of the supported host contract.
- Test: `tests/utils/test-mdx-document.test.ts`.

**Interfaces:**

- Consumes: UTF-8 string content.
- Produces:

```ts
interface MdxDocument {
  body: string;
  frontmatter: Record<string, unknown>;
  hasFrontmatter: boolean;
}

function parseMdxDocument(content: string): MdxDocument;
```

- [ ] **Step 1: Write failing parser tests**

Cover YAML scalars, block/inline string arrays, nested JSON-compatible metadata, BOM handling, no-frontmatter passthrough, closing delimiter handling, and malformed YAML rejection:

```ts
const parsed = parseMdxDocument("---\\ntitle: Demo\\ntags:\\n  - alpha\\n---\\nBody");
assert.deepEqual(parsed.frontmatter, { title: "Demo", tags: ["alpha"] });
assert.equal(parsed.body, "Body");

assert.deepEqual(parseMdxDocument("plain text"), {
  body: "plain text",
  frontmatter: {},
  hasFrontmatter: false,
});

assert.throws(() => parseMdxDocument("---\\ntitle: [unterminated\\n---\\nBody"));
```

- [ ] **Step 2: Run the parser test and verify RED**

Run:

```powershell
corepack pnpm test -- tests/utils/test-mdx-document.test.ts
```

Expected: module-not-found or missing-function failure.

- [ ] **Step 3: Add `yaml` and implement the parser**

Use `yaml.parse` on only the text between a leading `---` delimiter and a closing `---`/`...`. Reject non-object documents, non-JSON-compatible values, and parser errors with a normal `Error`; do not execute or transform MDX JSX. Preserve the body without front matter and without an accidental leading blank line.

- [ ] **Step 4: Run the parser tests and verify GREEN**

Run the focused command again. Expected: all parser cases pass.

- [ ] **Step 5: Refactor only after green**

Keep delimiter detection and YAML validation in this utility; do not spread front-matter parsing through ingestion stages.

### Task 3: Integrate MDX metadata, body checksums, and tags into ingestion

**Files:**

- Modify: `src/stages/ingestion/file-reader.ts:1-151` to parse MDX, merge metadata, expose body content, and use the body checksum for front-matter documents.
- Modify: `src/stages/ingestion/tag-extractor.ts:1-31` and `src/utils/text-preprocessor.ts:31-109` to normalize front-matter tags through existing rules and merge them with trailing `Tag:` tags.
- Modify: `src/errors.ts` only if a dedicated ingestion error wrapper is needed; otherwise use the existing stage boundary.
- Test: `tests/stages/test-ingestion-stages.test.ts`, `tests/stages/test-ingestion-write-stages.test.ts`, and `tests/adapters/test-filesystem-ingestion-adapter.test.ts`.

**Interfaces:**

- Consumes: `FileInput`/`PipelineData` with `.md` or `.mdx` content and optional existing `documentMetadata`.
- Produces: body-only `content`, merged JSON-compatible `documentMetadata`, `needsEmbedding=false` for front-matter-only changes, and normalized union tags.

- [ ] **Step 1: Write failing ingestion tests**

Add a `.mdx` fixture with front matter and assert:

```ts
const out = await new FileReaderStage().process({ path: filePath }, ctx);
assert.equal(out.content, "Body text");
assert.deepEqual(out.documentMetadata, {
  path: "note.mdx",
  mtime: out.mtime,
  size: out.size,
  title: "Demo",
  tags: ["alpha", "beta"],
});
```

Ingest once, change only `title`/`tags`, ingest again, and assert the second run has `needsEmbedding === false` while the stored `metadata_json` and file tags change. Add a malformed-front-matter test that rejects with the source path. Add a legacy `.md` test proving no-frontmatter behavior is unchanged.

- [ ] **Step 2: Run the focused ingestion tests and verify RED**

Run:

```powershell
corepack pnpm test -- tests/stages/test-ingestion-stages.test.ts tests/stages/test-ingestion-write-stages.test.ts tests/adapters/test-filesystem-ingestion-adapter.test.ts
```

Expected: front matter remains in content, tags are missing, or metadata-only changes re-embed.

- [ ] **Step 3: Implement the smallest integration**

In `FileReaderStage`, parse after obtaining stable content. Merge adapter metadata first, then front matter. For front-matter documents, set `content` to `parsed.body`, compute `checksum` from the body, and compare serialized merged metadata to the stored row. For plain files, retain the current raw-content checksum and behavior. In `TagExtractorStage`, obtain `metadata.tags` as a string or string array, pass those values through a shared normalization helper, and union them with trailing `Tag:` extraction while applying blacklist/length/max-count rules once.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the same command. Expected: all MDX, metadata-only, tag, malformed-input, and legacy tests pass.

- [ ] **Step 5: Refactor after green**

Keep the parser independent of persistence and keep tag normalization in `text-preprocessor.ts`; do not change `SearchResult` fields.

### Task 4: Move the demo and documentation to the MDX data layout

**Files:**

- Create: `data/README.md`.
- Create: `data/content/life/coffee.mdx`, `data/content/memory/cold-knowledge.mdx`, and `data/content/quantum/qubit.mdx`.
- Modify: `examples/demo/main.ts` to read canonical MDX sources from `data/content` and write only generated state under `data/memoria`.
- Modify: `examples/demo/README.md` to document `data/content` and `data/memoria` ownership.
- Modify: `README.md`, `docs/GUIDE.md`, `docs/PERSISTENCE.md`, and `docs/ARCHITECTURE.md` with the default layout, MDX contract, cache/rebuild policy, and TDB paths.
- Test: add a deterministic demo/data-layout assertion under `tests/integration/` or the existing demo test surface.

**Interfaces:**

- Consumes: `data/content/**/*.mdx`.
- Produces: no root-level runtime `VectorStore/`; demo state under `data/memoria/`.

- [ ] **Step 1: Write the data-layout verification first**

Assert that the canonical source inventory contains exactly the three `.mdx` demo sources, each has front matter with `tags`, and the demo configuration points to `data/content` and `data/memoria`.

- [ ] **Step 2: Run the layout test and verify RED**

Run:

```powershell
corepack pnpm test -- tests/integration/test-data-layout.test.ts
```

Expected: missing directory/files or old demo paths.

- [ ] **Step 3: Add canonical MDX sources and update the demo**

Keep the three existing demo meanings and tags, moving metadata into YAML front matter. The demo must not recursively delete the entire `data/` root; it may clear only its own generated `data/memoria/` state before rebuilding. Use the source files as inputs instead of writing `.md` strings at runtime.

- [ ] **Step 4: Run demo/layout verification and verify GREEN**

Run the focused test and the demo command from the repository root. Confirm generated SQLite/index files appear only under `data/memoria/` and search results still include body, tags, and metadata.

- [ ] **Step 5: Update documentation and refactor prose**

Remove stale “VectorStore is the default” and “geodesic does not belong here” wording where it conflicts with current behavior. Keep legacy explicit path examples documented as compatibility options.

### Task 5: Migrate and clean known generated artifacts safely

**Files/targets:**

- Modify: worktree `examples/demo/demo-data/` only if it remains after the demo migration.
- Remove or move: worktree `VectorStore/` after verifying it contains only `.usearch`/`.meta.json` generated files and no SQLite authority/source.
- Remove or move: worktree `VectorStoreTDB/` and `knowledge/` only when empty or generated-only; preserve any discovered user-authored files.
- Do not touch: `eval/`, `src/`, `tests/`, or unrelated uncommitted files.

- [ ] **Step 1: Capture an artifact manifest before mutation**

Record absolute paths, SHA-256 hashes, sizes, and file types for each exact cleanup target. Stop and report if a target contains anything other than known generated artifacts.

- [ ] **Step 2: Rebuild canonical demo state**

Run the updated demo once, close the engine, and verify `data/memoria/memory.sqlite` plus `data/memoria/indexes/index_*.usearch` exist and reopen successfully.

- [ ] **Step 3: Remove exact stale generated targets**

Use validated absolute paths and PowerShell `Remove-Item -LiteralPath` only for generated-only targets. Do not use recursive deletion against a workspace root or unresolved variables. Report what was removed and retain the pre-clean manifest in the final handoff.

- [ ] **Step 4: Verify no old runtime paths were recreated**

Run `rg --files` for root-level `VectorStore`, `VectorStoreTDB`, and `examples/demo/demo-data`; inspect `git status --short` and the final `data/` inventory.

### Task 6: Full verification and completion audit

**Files:**

- No new production files; update tests/docs only where failures expose a real contract gap.

- [ ] **Step 1: Run the full test suite**

```powershell
corepack pnpm test
```

Expected: all non-live tests pass and only the existing four real-API tests skip.

- [ ] **Step 2: Run public typecheck and lint**

```powershell
corepack pnpm typecheck:public
corepack pnpm lint
git diff --check
```

- [ ] **Step 3: Audit every objective requirement**

Verify from current files and command output: default paths derive from `data/`; MDX files are canonical source; front matter reaches tags/metadata; body-only embedding reuse works; SQLite/index state is separated; known stale caches are gone or explicitly preserved with reason; `eval/` is unchanged; no public search contract changed.

- [ ] **Step 4: Commit the implementation only after all gates pass**

Stage only the intended source, test, documentation, data-source, and cleanup changes. Leave unrelated existing changes unstaged and report the final commit/hash and verification counts.
