# Repository instructions for AI Agents

These instructions apply to the repository root. Deeper `AGENTS.md` files add
rules for their own scopes; current nested scopes include
[docs/AGENTS.md](docs/AGENTS.md),
[tutorials/AGENTS.md](tutorials/AGENTS.md), [scripts/AGENTS.md](scripts/AGENTS.md),
[tests/AGENTS.md](tests/AGENTS.md), [rust-vexus-lite/AGENTS.md](rust-vexus-lite/AGENTS.md),
and [docs/superpowers/AGENTS.md](docs/superpowers/AGENTS.md).

## Mission and boundaries

Keep the repository's human documentation accurate and easy to navigate. Do
not change production behavior for a documentation-only request. Preserve
unrelated worktree changes and inspect untracked files before deciding what is
safe to edit.

`eval/` is intentionally Git-ignored and outside the maintenance scope. Do not
read it for documentation work, add it to indexes, change its files, or delete
it. Generated `dist/`, `dist-test/`, runtime databases, and vector indexes are
not documentation sources.

The repository does not maintain a root `data/` tree. Controlled tutorial source
data lives under `tutorials/data/content/` as `.mdx`; each tutorial's
`data/runtime/` is ignored generated state. The library's `dataPath` option is
consumer-owned runtime configuration and is not package data.

This repository currently has no project-local `SKILL.md` or `Skills/`
directory. Do not create a project skill merely to mirror system-level agent
skills. Put human procedures in `docs/` and repository-wide AI rules here.

## Authority order

When prose conflicts with implementation, resolve the conflict in this order:

1. `package.json`, `pnpm-lock.yaml`, and TypeScript/Rust compiler metadata;
2. `src/`, `rust-vexus-lite/`, and public type declarations;
3. tests, fixtures, tutorials, and `.github/workflows/ci.yml`;
4. existing documentation and historical plans/specifications.

Generated `dist/` output may be inspected to verify packaging, but it is never
the source of a new API claim. If current behavior cannot be verified, say so
explicitly instead of guessing.

## Required workflow

Before editing:

1. Run `git status --short --branch` and preserve unrelated changes.
2. Read `package.json`, relevant `tsconfig` files, and the CI workflow.
3. Locate the implementation, tests, and tutorials for the behavior being
   documented.
4. Search all maintained Markdown files for duplicate terminology, commands,
   paths, and links.
5. Decide which file is canonical before editing repeated prose.

While editing:

- Keep human instructions operational: state prerequisites, exact commands,
  paths, inputs, outputs, and known limits.
- Keep AI instructions here: state trigger conditions, scope, authority,
  preservation rules, tool/command expectations, and verification gates.
- Use repository-root commands with `corepack pnpm` unless a command explicitly
  runs inside `rust-vexus-lite/`.
- Prefer stable concepts and source references over volatile generated counts.
- Update the nearest index and cross-references when adding or moving a doc.
- Do not introduce environment variables, APIs, files, or supported platforms
  that are not present in the current implementation or CI configuration.

## Verification

For documentation changes, run the focused documentation check first, then the
repository gates that the current environment can execute:

```powershell
corepack pnpm verify:docs
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm typecheck:public
corepack pnpm test
corepack pnpm verify:public
corepack pnpm verify:pack
git diff --check
```

Do not claim a check passed without fresh command output. Report live-provider
skips, native/platform gaps, or missing credentials as bounded verification
results rather than silently treating them as success.
