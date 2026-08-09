# Release checklist

Run these commands from the repository root with Node `>=24.18.1 <25` and Corepack
using pnpm `11.20.0`:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm typecheck:public
corepack pnpm test
corepack pnpm test:native
corepack pnpm verify:public
corepack pnpm verify:pack
corepack pnpm pack --dry-run
git diff --check
```

这些本地命令是发布判断的权威证据；不要求额外等待或依赖 GitHub Actions run。
真实 API 集成测试没有 key 时可以按 `docs/TROUBLESHOOTING.md` 的说明 skip，不能
把网络不可用伪装成通过。

Rust gate：

```bash
cd rust-vexus-lite
cargo fmt --check
cargo test
cargo build --release
cargo clippy --all-targets --all-features -- -D warnings
```

The release artifact must contain `dist/`, `README.md`, `CHANGELOG.md`, the generated
N-API loader and only the native binaries listed in [NATIVE-MATRIX.md](./NATIVE-MATRIX.md).
It must not contain `src/`, `tests/`, `dist-test/`, SQLite databases, or temporary
tarballs.

Before publishing, confirm that `Object.keys(require("memoria"))` still contains the
historical 41 root exports, while ESM consumers import `dist/index.js` and receive
`dist/index.d.ts`. Keep database files and vector-index formats backward compatible;
the SQLite logical-document columns are added through idempotent migrations.
