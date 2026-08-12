# Documentation Scope Instructions

## Scope

These instructions apply to `docs/`. The repository root `AGENTS.md` remains
authoritative for cross-cutting rules; this file adds documentation-specific
constraints only.

## Source and ownership

- Read `README.md` and `INDEX.md` before changing a maintained document.
- Treat package manifests, source, tests, tutorials, and CI as the current
  evidence. Do not promote plans or design records into current behavior.
- Keep one canonical owner for each important fact. Link summaries to the
  owner instead of copying full configuration tables, API inventories, or
  command lists.

## Language and boundaries

- Human-facing current documentation MUST use concise Simplified Chinese.
- Identifiers, commands, paths, API names, configuration keys, and environment
  variables MUST remain in their authoritative spelling.
- AI-facing operational documentation MUST use concise technical English.
- Do not read, edit, index, or link `eval/`; it is outside this scope.
- Do not treat `dist/`, `dist-test/`, runtime databases, vector indexes, or
  dependencies as documentation sources.

## Required workflow

1. Identify the audience and canonical owner before editing.
2. Verify commands, paths, interfaces, configuration, and tutorials against the
   current repository.
3. Update `INDEX.md` when adding or retiring a maintained document.
4. Run `corepack pnpm verify:docs` after documentation or navigation changes.
5. Run the relevant root quality gates before completion and report any
   credential, platform, or baseline limitation explicitly.
