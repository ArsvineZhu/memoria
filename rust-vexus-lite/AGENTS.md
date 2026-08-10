# Agent Instructions: `rust-vexus-lite/`

## Scope and role

This directory contains the Rust N-API vector/index binding used by the main
Node runtime. These instructions apply only to this subtree. The repository
root `AGENTS.md` remains authoritative for cross-cutting work.

## Source of truth

- Rust implementation: `src/`
- N-API metadata and build settings: `Cargo.toml`, `package.json`
- Native loader and exported types: `index.js`, `index.d.ts`
- Platform artifacts: root-level `*.node` files
- TypeScript host adapter: `../src/providers/vexus-vector-store.ts`
- Native tests: `../tests/native/` and Rust tests in `src/`

The current host integration is through the TypeScript Vexus adapter, not a
legacy JavaScript manager.

## Required workflow

1. Inspect the loader, Rust exports, TypeScript adapter, and native tests before
   changing an exported symbol, argument, return shape, or artifact name.
2. Preserve the loader ABI, platform filename convention, and CommonJS package
   boundary unless the root package and all consumers are updated together.
3. Run focused Rust checks for Rust changes:
   `cargo fmt --check`, `cargo test`, and `cargo build --release`.
4. Run the root native/package checks before handoff:
   `corepack pnpm test:native`, `corepack pnpm verify:pack`, and the relevant
   root build/type checks.
5. Update the corresponding advanced documentation when the public native
   surface, supported platform matrix, build process, or failure behavior
   changes.

## Boundaries

- Do not edit `eval/`; it is Git-ignored and outside documentation scope.
- Do not commit generated `target/`, `node_modules/`, `dist/`, or temporary
  native build output.
- Do not change Rust persistence/recovery behavior without checking the
  TypeScript lifecycle and persistence contracts.
