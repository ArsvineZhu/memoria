# Native distribution matrix

`rust-vexus-lite/index.js` is the generated N-API-RS loader and remains CommonJS-scoped.
The TypeScript facade validates its `unknown` return boundary without changing the
generated loader or exported Rust symbols.

The package currently contains these platform-specific binaries:

| Platform            | ABI file                           |
| ------------------- | ---------------------------------- |
| Windows x64 / MSVC  | `vexus-lite.win32-x64-msvc.node`   |
| macOS arm64         | `vexus-lite.darwin-arm64.node`     |
| Linux x64 / glibc   | `vexus-lite.linux-x64-gnu.node`    |
| Linux x64 / musl    | `vexus-lite.linux-x64-musl.node`   |
| Linux arm64 / glibc | `vexus-lite.linux-arm64-gnu.node`  |
| Linux arm64 / musl  | `vexus-lite.linux-arm64-musl.node` |

The tarball also carries the generic `vexus-lite.node` artifact shipped by the
existing Rust package. It is not treated as evidence for an additional platform
selection path. Other loader branches require a separately published N-API
artifact and are not claimed by this package.

Native verification is split by environment:

- Windows: `corepack pnpm test:native` and `corepack pnpm verify:pack` are run locally.
- Linux and Windows CI: `.github/workflows/ci.yml` runs the same native smoke suite on
  `ubuntu-latest` and `windows-latest`.
- A clean consumer also loads `rust-vexus-lite` from the packed tarball and instantiates
  `VexusIndex`, so the published package does not depend on a local Rust toolchain.
