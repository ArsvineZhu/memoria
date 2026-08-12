# Documentation System Maintenance Design

> Historical record. This design captures the pre-maintenance repository state;
> it does not override current `AGENTS.md`, source, tests, CI, or documentation
> indexes.

**Date:** 2026-08-10

## Goal

Make the repository documentation discoverable, audience-specific, and
consistent with the current TypeScript package, Rust native package, data
layout, scripts, tests, and CI configuration.

`eval/` is explicitly outside the maintenance scope. It is local evaluation
material and will be ignored by Git; it will not be linked from repository
documentation or changed by this work.

## Current-state findings

- `README.md` is the only root entry point. There is no root `INDEX.md`,
  `AGENTS.md`, or contribution guide.
- `docs/` contains useful topic documents, but no directory index. Setup,
  configuration, testing, development, API, and release instructions are
  distributed across several files with repeated commands and paths.
- `rust-vexus-lite/AGENTS.md` is correctly scoped as a nested instruction file,
  but its main-runtime reference points at the absent historical
  a historical JavaScript integration instead of the current TypeScript implementation.
- There is no project-local `SKILL.md` or `Skills/` directory. The repository
  must not copy system-level skills into the project; AI-only workflow rules
  belong in `AGENTS.md`, while human procedures belong in `docs/`.
- The current package source of truth is `package.json`, `src/`, tests,
  tutorials, `.github/workflows/ci.yml`, and `rust-vexus-lite/` metadata. Docs
  must not invent commands or treat generated `dist/` output as source.

## Chosen structure

```text
README.md                 human landing page and shortest quick start
INDEX.md                  repository map and entry-point router
CONTRIBUTING.md           human contribution and local quality gates
AGENTS.md                 repository-wide AI-agent rules and boundaries
docs/
  INDEX.md                topic index grouped by audience and task
  GUIDE.md                first successful integration
  CONFIGURATION.md        configuration keys, defaults, derived paths, env mapping
  API.md                  public exports, methods, envelopes, and type surface
  ARCHITECTURE.md         components, lifecycle, pipeline boundaries
  FUNCTIONS.md            behavior-level feature reference
  EMBEDDING.md            provider contracts and dimension rules
  PERSISTENCE.md          SQLite/native state, recovery, and backup policy
  ALGORITHMS.md           algorithm explanations and verified limitations
  TESTING.md              local/CI test commands and skip behavior
  DEVELOPMENT.md          source layout, extension points, and maintenance workflow
  NATIVE-MATRIX.md        native package artifacts and supported build checks
  RELEASE-CHECKLIST.md    release and tarball acceptance gates
  TROUBLESHOOTING.md      symptom-based diagnosis
```

Existing topic documents remain in place unless a duplicate section can be
removed safely. New indexes link to canonical documents instead of repeating
their full content. `README.md` links to `INDEX.md` and the shortest user
paths; `INDEX.md` links to `docs/INDEX.md`, `CONTRIBUTING.md`, and `AGENTS.md`.

## Audience and authority rules

1. Ordinary-user documents use concise Chinese, explain procedures in detail,
   and avoid unnecessary technical vocabulary or English.
2. Advanced developer/operator documents use Chinese prose plus only the
   technical terms that reduce ambiguity, such as API names, paths, type names,
   and command names.
3. `AGENTS.md` and other AI-agent instructions use concise, precise technical
   English. They must state scope, authority, triggers, limits, workflow, and
   verification without mixing in ordinary-user guidance.
4. Human-facing documents must not contain hidden agent-control instructions.
5. `AGENTS.md` defines AI workflow boundaries: inspect current implementation,
   preserve unrelated changes, keep `eval/` out of scope, edit the narrowest
   authoritative document, and run verification before claiming completion.
6. `rust-vexus-lite/AGENTS.md` adds native-subproject rules only. Nested rules
   do not redefine repository-wide scope.
7. Source, tests, package metadata, CI, and example entry points outrank prose
   when a documentation statement conflicts with implementation.
8. Tutorials must use repository-root commands and paths that exist in the
   current tree. Volatile counts, generated filenames, and historical phase
   labels are removed or explicitly labeled as snapshots.

## Maintenance and verification

The maintenance change will add a lightweight documentation verifier for
relative Markdown links and referenced repository paths, and a package script
to run it. It will not attempt to parse TypeScript or generate API prose.

The final gate runs the repository's actual checks: `format:check`, `lint`,
`typecheck`, `build`, `typecheck:public`, `test`, `verify:public`,
`verify:pack`, the documentation verifier, and `git diff --check`. Live
embedding tests remain conditional on their existing key and are reported as
skipped when the key is absent.

## Deliberate non-goals

- Do not change production search, ingestion, persistence, or native behavior.
- Do not modify or document the contents of `eval/`.
- Do not create a project-local skills framework merely because system-level
  skill files exist outside the repository.
- Do not preserve hard-coded claims that can be derived from generated output
  and will drift; document the command or source of truth instead.
