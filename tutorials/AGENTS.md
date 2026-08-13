# Tutorial workspace instructions

This directory is the maintained user-facing tutorial and reference surface for the repository.

- Keep human-facing Markdown in Simplified Chinese. Keep API names, commands, paths, environment variables, and code identifiers unchanged.
- Every runnable tutorial must use only the package root or the supported public subpaths: `@arsvinezhu/memoria`, `@arsvinezhu/memoria/adapters/filesystem`, `@arsvinezhu/memoria/errors`, and `@arsvinezhu/memoria/providers/openai-compatible`.
- Do not import implementation modules, pipelines, stages, algorithms, native runtime handles, or internal utility types from tutorial code.
- Shared source data under `data/content` is read-only MDX input. Runtime databases and vector indexes belong below each lesson's `data/runtime` and must remain ignored.
- Provider selection is tutorial-only: complete `EMBED_*` or `RERANK_*` configuration selects the compatible provider; otherwise the tutorial uses its deterministic fake provider. A real request failure must not silently fall back.
- Keep the full code block in each lesson README synchronized with its `main.ts`; run the tutorial structure verifier after changes.
- `reference/` owns detailed public API and configuration facts. `algorithms/` owns retrieval algorithm explanations. Other documents should link to those owners instead of copying conflicting tables.
- Do not read or modify `eval/`, generated build output, native build output, or local secret files.
