# Workflow-Record Scope Instructions

## Scope

This subtree contains historical plans and design records. It is context, not
the current instruction or runtime source of truth.

## Rules

- Use the repository root `AGENTS.md`, the nearest active scope instructions,
  current source, tests, manifests, and CI for present behavior.
- Do not execute unchecked historical plan items merely because they remain in a
  record. Do not rewrite a record to hide what happened.
- If a current rule is learned from a record, project it into the canonical
  human document or applicable `AGENTS.md`; keep the record historical.
- Preserve the existing record layout unless the repository maintainer requests
  archival or removal. Keep links and status descriptions accurate.
- Do not read, edit, or link `eval/`.

## Verification

After changing a record index or record links, run `corepack pnpm verify:docs`.
Historical records may use technical English; current human documentation and
current AI instructions follow their respective language policies.
