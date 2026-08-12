# Documentation System Maintenance Implementation Plan

> Historical record. This plan records the maintenance work and its intended
> verification; current repository state and command output are authoritative.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring all in-scope repository documentation into a single, navigable, audience-specific system that matches the current implementation and verified commands.

**Architecture:** Keep existing topic documents as canonical references, add root and `docs/` routers plus focused configuration/testing/development/contribution guides, and remove duplicated or volatile prose from the landing pages. Keep AI instructions in `AGENTS.md` and human procedures in `docs/`; ignore `eval/` without touching it.

**Tech Stack:** Markdown, TypeScript/NodeNext repository sources, Corepack pnpm, Prettier, Oxlint, Node `node:test`, and PowerShell on the local Windows environment.

## Global Constraints

- `eval/` is out of scope: add it to `.gitignore`, do not edit it, and do not link it from maintained documentation.
- Treat `package.json`, `src/`, tests, tutorials, `.github/workflows/ci.yml`, and `rust-vexus-lite/` metadata as implementation authorities.
- Preserve unrelated existing worktree changes; only the existing untracked `eval/` is intentionally hidden by the ignore rule.
- Do not change production behavior; source-comment edits must clarify existing behavior only.
- Use `corepack pnpm` for root commands and exact paths that exist in the current tree.
- Remove volatile counts and historical phase labels unless they are explicitly identified as snapshots.
- Use concise, detailed Chinese for ordinary-user documentation; use Chinese with necessary technical terms for advanced documentation; use concise technical English for AI-agent instructions.
- Run `git diff --check` and the relevant package verification commands before completion claims.

---

### Task 1: Add repository scope, navigation, and AI boundaries

**Files:**

- Modify: `.gitignore`
- Create: `INDEX.md`
- Create: `AGENTS.md`
- Create: `docs/INDEX.md`

**Interfaces:**

- `README.md` links to `INDEX.md`.
- `INDEX.md` links to `docs/INDEX.md`, `CONTRIBUTING.md`, and `AGENTS.md`.
- `docs/INDEX.md` links to every maintained topic document and declares that no project-local `SKILL.md` or `Skills/` directory exists.
- `AGENTS.md` applies to the repository; `rust-vexus-lite/AGENTS.md` remains the nested native exception.

- [x] Add `eval/` to `.gitignore` and confirm with `git check-ignore eval eval/README.md`.
- [x] Write `INDEX.md` with the source/data/runtime boundary, main entry points, human and AI routes, and an explicit exclusion for `eval/`.
- [x] Write `AGENTS.md` with required inspection order, authority precedence, edit boundaries, verification rules, and no-`eval/` policy.
- [x] Write `docs/INDEX.md` with task/audience tables and one canonical link per topic.
- [x] Check every new relative link against the current filesystem before moving on.

### Task 2: Add contributor, development, configuration, and testing entry points

**Files:**

- Create: `CONTRIBUTING.md`
- Create: `docs/CONFIGURATION.md`
- Create: `docs/TESTING.md`
- Create: `docs/DEVELOPMENT.md`
- Modify: `package.json` only if a docs verifier script is added in Task 5

**Interfaces:**

- `CONTRIBUTING.md` is the human contribution entry point and links to
  `docs/DEVELOPMENT.md` and `docs/TESTING.md`.
- `docs/CONFIGURATION.md` is the only full configuration-key reference;
  `docs/GUIDE.md` links to it instead of duplicating the table.
- `docs/TESTING.md` uses the scripts actually declared in `package.json` and
  mirrors the blocking/non-blocking behavior in `.github/workflows/ci.yml`.

- [x] Document the verified runtime floors (`node` engine and pnpm package manager), frozen install, build/typecheck/lint/test gates, and native subproject commands.
- [x] Derive the configuration table from `src/config/default-config.ts` and `src/types.ts`, covering `dataPath`, derived main/TDB paths, provider settings, pipeline gates, retrieval/post-processing knobs, and TDB settings without inventing environment variables.
- [x] Document the actual `.env` consumers and the fact that the live OpenAI-compatible test and provider-selection tutorial use their respective `.env` locations if the source confirms that distinction.
- [x] Document extension points using actual exports/interfaces (`EmbeddingProviderContract`, `MetadataStoreContract`, `VectorStoreContract`, stages, and filesystem adapter).
- [x] Add a contributor workflow that ends with `corepack pnpm format:check`, `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm test`, and `git diff --check`.

### Task 3: Reconcile the landing page and core user/API references

**Files:**

- Modify: `README.md`
- Modify: `docs/GUIDE.md`
- Modify: `docs/API.md`
- Modify: `docs/FUNCTIONS.md`

**Interfaces:**

- README quick-start snippets use the verified public import/type contract;
  executable offline usage points to the maintained demo instead of pretending
  the demo-only provider is a package export.
- API export names and subpath exports must match `package.json` and the
  public source entry; do not retain an unverified hard-coded export count.
- Guide configuration links point to `docs/CONFIGURATION.md`.

- [x] Replace duplicated or stale repository-tree prose with links to `INDEX.md` and the canonical data README.
- [x] Verify every README command, import path, output path, and example filename against the current package scripts, source, and example tree.
- [x] Rewrite the navigation table by audience/task and include the new indexes, contribution guide, configuration, testing, development, and agent instructions.
- [x] Remove repeated full configuration tables from `GUIDE.md`, retaining setup, minimal ingest/search/delete/stat snippets and links to canonical references.
- [x] Reconcile API and functions prose with the actual root exports, subpath exports, engine methods, envelope names, TDB behavior, and formal adapter entry points.

### Task 4: Reconcile architecture, data, algorithms, operations, and tutorials

**Files:**

- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/PERSISTENCE.md`
- Modify: `docs/EMBEDDING.md`
- Modify: `docs/ALGORITHMS.md`
- Modify: `docs/TROUBLESHOOTING.md`
- Modify: `docs/NATIVE-MATRIX.md`
- Modify: `docs/RELEASE-CHECKLIST.md`
- Modify: tutorial-owned data documentation under `tutorials/`
- Modify: tutorial READMEs under `tutorials/`
- Modify: `rust-vexus-lite/AGENTS.md`
- Modify: selected stale source comments under `src/` and `rust-vexus-lite/`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Architecture and persistence documents agree on metadata authority,
  derived vector indexes, lifecycle, recovery, and MDX source ownership.
- Embedding, troubleshooting, native, and release documents share the same
  model, dimension, package, and artifact facts.
- Example instructions run from the repository root using current scripts.
- Nested native instructions refer to current TypeScript call sites and native
  package metadata.

- [x] Remove stale path names, historical phase labels, unsupported platform claims, and references to absent files after checking each against source/config/tests.
- [x] Consolidate MDX/data-path ownership and backup/ignore policy around the example READMEs.
- [x] Make troubleshooting entries symptom-first, link to canonical configuration/persistence/testing guidance, and label live-key requirements precisely.
- [x] Make the native matrix and release checklist state what is verified from the current tree/CI versus what requires a platform-specific manual build.
- [x] Update example READMEs for exact build/run locations, required files, and expected no-key behavior.
- [x] Add an Unreleased changelog entry for the documentation system and Git ignore boundary.

### Task 5: Add repeatable documentation verification

**Files:**

- Create: `scripts/verify-docs.mjs`
- Modify: `package.json`
- Modify: `docs/DEVELOPMENT.md`
- Test: execute `corepack pnpm verify:docs`

**Interfaces:**

- `scripts/verify-docs.mjs` scans only maintained Markdown files, excluding
  `eval/`, generated directories, dependencies, and fixtures.
- It fails on missing relative Markdown targets and reports file/line/target.
- `package.json` exposes `verify:docs` without changing production scripts.

- [x] Define the maintained-file roots explicitly (`README.md`, `INDEX.md`, `CONTRIBUTING.md`, `AGENTS.md`, `docs/`, example READMEs, and the nested native AGENT file).
- [x] Write and run the verifier against the current docs.
- [x] Implement only relative-target and fragment-safe path checking; ignore external URLs, mail links, code blocks, and `eval/`.
- [x] Add the command to the development/contribution documentation and run it after all prose changes.

### Task 6: Full verification and completion audit

**Files:**

- No additional files unless a verification failure exposes a real documentation mismatch.

- [x] Run `corepack pnpm verify:docs` and inspect all reported targets.
- [x] Run `corepack pnpm format:check`, `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm build`, `corepack pnpm typecheck:public`, `corepack pnpm test`, `corepack pnpm verify:public`, `corepack pnpm verify:pack`, and `git diff --check`.
- [x] Confirm `eval/` is ignored, unchanged, absent from maintained indexes, and still present on disk without deletion.
- [x] Re-scan all maintained docs for stale paths, duplicate commands, project-local `SKILL.md` claims, historical implementation references, and unsupported phase/count assertions.
- [x] Review `git diff --stat`, `git diff --name-status`, and final status; preserve unrelated changes and report any platform/live-key checks that could not be proven locally.

`corepack pnpm format:check` was executed and still reports the repository's
pre-existing formatting baseline outside the maintained documentation set;
targeted Prettier checks for every changed documentation, workflow, script, and
configuration file pass.
