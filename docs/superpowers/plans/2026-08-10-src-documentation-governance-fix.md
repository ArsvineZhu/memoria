# Source Documentation Governance Fix Implementation Plan

> Historical record. This plan records the approved repair scope; current repository state and command output are authoritative.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the `src/` documentation boundary, make public API ownership explicit, document the public error subpath, and detect runtime-export drift.

**Architecture:** Add concise local human and AI entry points under `src/`, link them from existing navigation, keep `package.json` and `src/` as API authorities, and extend the existing documentation verifier with a source-export snapshot check. Do not change production behavior or generated output.

**Tech Stack:** Markdown, Node ESM verification script, TypeScript source metadata, Corepack pnpm, Git.

## Global Constraints

- `eval/`, `dist/`, `dist-test/`, runtime databases, and native build output remain out of scope.
- Human documentation remains concise Chinese; `src/AGENTS.md` remains concise technical English.
- `package.json`, `src/index.ts`, `src/index.cts`, `src/errors.ts`, public types, tests, and CI are the factual authorities.
- Keep existing documentation architecture and make the smallest navigation and ownership repair.
- Run `corepack pnpm verify:docs`, formatting, lint, typecheck, build, public checks, tests, packaging, and `git diff --check` before publishing.

---

### Task 1: Add the `src/` scope entry points and navigation

**Files:**

- Create: `src/README.md`
- Create: `src/AGENTS.md`
- Modify: `INDEX.md`
- Modify: `docs/DEVELOPMENT.md`

**Interfaces:**

- `src/README.md` explains the TypeScript source boundary, public entry points, durable subareas, adjacent docs, and source-only workflow.
- `src/AGENTS.md` adds only local AI rules: public-surface synchronization, CJS facade parity, generated-file boundaries, and source-focused verification.
- Root and documentation navigation expose the new scope entry points.

- [x] Write the local human README with links to canonical API, architecture, configuration, embedding, algorithms, persistence, testing, and development references.
- [x] Write the local technical-English AGENTS file without repeating root policy.
- [x] Add `src/README.md` and `src/AGENTS.md` to root/development navigation.
- [x] Run `corepack pnpm verify:docs` and confirm all new links resolve.

### Task 2: Repair API ownership language and document errors

**Files:**

- Modify: `docs/API.md`

**Interfaces:**

- The API reference names `package.json`, `src/index.ts`, `src/index.cts`, `src/errors.ts`, and public types as authorities.
- The generated `dist/` tree is described only as a packaging/runtime verification output.
- The `memoria/errors` subpath documents `MemoriaErrorCode`, `MemoriaErrorOptions`, `MemoriaError`, and `asMemoriaError` from the current source.

- [x] Replace the opening generated-output authority wording.
- [x] Add the stable error-code and error-object contract next to the subpath export table.
- [x] Run the focused documentation verifier.

### Task 3: Add runtime-export drift verification

**Files:**

- Modify: `docs/API.md`
- Modify: `scripts/verify-docs.mjs`
- Modify: `docs/DEVELOPMENT.md`

**Interfaces:**

- `docs/API.md` contains a marked, source-order runtime-export block.
- `scripts/verify-docs.mjs` parses `src/index.ts` and compares its runtime export names with that marked block, reporting a non-zero failure on drift.
- `corepack pnpm verify:docs` remains the single focused documentation command.

- [x] Replace the unmarked export snapshot with a marked one-name-per-line block.
- [x] Add a verifier function that reads only the runtime export block and the marked documentation block.
- [x] Add the export-drift check to the existing verifier output and development instructions.
- [x] Run the verifier once with matching source/docs and inspect its output.

### Task 4: Verify, commit, push, and publish

**Files:**

- No additional files unless verification exposes a factual mismatch in the changed documentation.

- [x] Run `corepack pnpm verify:docs`.
- [x] Run `corepack pnpm format:check`, `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm build`, `corepack pnpm typecheck:public`, `corepack pnpm test`, `corepack pnpm verify:public`, `corepack pnpm verify:pack`, and `git diff --check`.
- [x] Review `git diff --check`, `git diff --stat`, and `git status --short --branch`; stage only the intended files.
- [ ] Commit with a terse documentation-governance message.
- [ ] Push `codex/src-documentation-governance` with upstream tracking.
- [ ] Open a draft pull request with the change summary and fresh verification evidence.

The full repository `corepack pnpm format:check` remains blocked by the existing
formatting baseline outside this change. Targeted Prettier checks for every
changed documentation and script file pass.
