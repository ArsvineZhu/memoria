# Test Scope Instructions

## Scope

This file applies to `tests/`. The repository root `AGENTS.md` and `docs/TESTING.md`
remain authoritative for shared commands and test policy.

## Rules

- Add regression coverage for behavior changes at the narrowest applicable test
  layer; do not weaken an existing assertion to make stale documentation pass.
- Keep `tests/fixtures/` as test input only. Do not treat fixtures as production
  data or documentation sources, and do not copy `eval/` material into them.
- Preserve the live DashScope skip behavior when `EMBED_API_KEY` is absent; a
  skipped live test is not evidence of a verified network integration.
- Compile with `corepack pnpm build:test` before executing individual compiled
  tests. Do not commit `dist-test/`.

## Synchronization

When a test changes a public contract, configuration key, data format, or
platform claim, inspect its canonical documentation owner and the relevant
example or CI workflow before completion.
