# Source Scope Instructions for AI Agents

This scope contains the TypeScript package source for `memoria`.

## Local boundaries

- Treat `src/index.ts`, `src/index.cts`, `src/types.ts`, `src/errors.ts`, and
  `package.json` exports as the public-surface authorities.
- Keep `MemoryEngine` logical-document behavior separate from the filesystem
  adapter. Keep Rust implementation changes inside `rust-vexus-lite/` and read
  that scope's `AGENTS.md` before changing the native boundary.
- Do not edit generated `dist/` or `dist-test/`, runtime databases, vector
  indexes, or `eval/` for source work.

## Synchronization triggers

- When changing a root or subpath export, update `src/index.cts` when needed,
  the public API reference, and the relevant public/type/consumer tests.
- When changing lifecycle, persistence, configuration, provider, adapter, or
  algorithm behavior, check the corresponding canonical document under `docs/`
  before completion.
- When changing a source boundary, update the nearest repository or scope
  navigation entry.

## Verification

Use repository-root commands with `corepack pnpm`. At minimum, run the focused
documentation check for documentation-facing changes; public-surface changes
also require `corepack pnpm typecheck:public` and the relevant tests. The root
`AGENTS.md` owns the complete repository verification gate.
