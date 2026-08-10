# Example Scope Instructions

## Scope

This file applies to `examples/` and its child examples. The repository root
`AGENTS.md` remains authoritative for shared rules.

## Boundaries

- Keep `demo/` offline and deterministic; do not add a network or credential
  requirement to its documented path.
- Keep `real-embed/` explicit about its DashScope dependency and `.env` location.
- Never commit secrets, `.env` files, generated `dist-test/` output, or runtime
  databases and indexes.
- The child `package.json` files are private example metadata. Root commands and
  the root lockfile define the supported build workflow.

## Synchronization and verification

- Verify example imports and configuration against the public TypeScript types
  and root `package.json` exports.
- Update the nearest example README and the canonical docs when behavior or
  prerequisites change.
- Run `corepack pnpm build:test`, `corepack pnpm lint`, and the offline demo when
  the environment permits. Run the real-embedding example only with an explicit
  key and report network verification separately.
