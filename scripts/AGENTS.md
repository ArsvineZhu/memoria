# Repository Tooling Instructions

## Scope

This file applies to `scripts/`. The root `AGENTS.md` defines shared repository
rules.

## Rules

- Keep scripts deterministic, read-only unless their command explicitly owns a
  build or verification side effect, and safe around excluded paths.
- `verify-docs.mjs` is the canonical maintained-document link check. When a
  maintained documentation scope changes, update its roots and exclusion rules
  deliberately; do not silently scan `eval/`, generated output, dependencies,
  or fixtures.
- `verify-packed-consumer.mjs` must continue to validate the package boundary,
  not internal source imports.
- Do not commit generated output produced by verification scripts.

## Verification

Run the affected script, then `corepack pnpm lint` and the relevant root build or
consumer check. Keep command and path claims synchronized with `package.json`
and CI.
