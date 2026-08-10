# Workflow Records

This directory contains design and execution records produced during repository
maintenance. They are historical context, not current agent instructions and
not a second source of truth for runtime behavior.

Current instructions are defined by the repository-root `AGENTS.md` and the
nearest applicable nested `AGENTS.md`. Current implementation, configuration,
tests, and CI take precedence over claims in these records.

## Records

Current maintenance records:

- `specs/2026-08-10-documentation-system-design.md` — documentation-system
  design and audience boundaries for the current maintenance task.
- `plans/2026-08-10-documentation-system-maintenance.md` — execution plan and
  verification checklist for the same task.

Earlier implementation records:

- `plans/2026-08-09-memoria-engine-remediation.md` — engine remediation plan.
- `plans/2026-08-10-mdx-data-layout.md` — MDX and persistent-data layout plan.
- `specs/2026-08-10-mdx-data-layout-design.md` — MDX and persistent-data design.

When a plan is complete, keep it as an audit record unless the repository
maintainer explicitly requests its removal. Do not infer unfinished work from
unchecked historical checklist items; verify the current worktree and command
results instead.
