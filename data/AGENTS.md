# Data Scope Instructions

## Scope

This file applies to `data/`. The repository root `AGENTS.md` remains
authoritative for shared rules.

## Ownership boundary

- Tracked Markdown/MDX under `content/` is source data and may be edited when a
  fixture or example requires it.
- `memoria/` and `tdb/` are runtime state. Do not hand-edit SQLite files,
  vector indexes, sidecars, WAL files, or generated directories.
- `knowledge/` is the optional TDB source root; verify its consumer before
  changing its layout.
- `eval/` is outside the repository documentation and data-maintenance scope;
  do not read or modify it.

## Synchronization

When changing the source-data layout or front matter contract, inspect the
configuration, ingestion parser, persistence docs, and tests together. Update
`README.md` and the canonical docs before changing summaries elsewhere.

## Verification

Use the root workflow. At minimum, run `corepack pnpm verify:docs` for
documentation changes and the relevant MDX/data tests plus `corepack pnpm test`
for behavior changes. Never commit generated runtime state.
