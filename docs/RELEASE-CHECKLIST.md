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
corepack pnpm verify:public
corepack pnpm verify:pack
corepack pnpm pack --dry-run
git diff --check
```

The release artifact must contain `dist/`, `README.md`, `CHANGELOG.md`, the generated
N-API loader and only the native binaries listed in [NATIVE-MATRIX.md](./NATIVE-MATRIX.md).
It must not contain `src/`, `tests/`, `dist-test/`, SQLite databases, or temporary
tarballs.

Before publishing, confirm that `Object.keys(require("memoria"))` still contains the
historical 41 root exports, while ESM consumers import `dist/index.js` and receive
`dist/index.d.ts`. Keep database files and vector-index formats backward compatible;
the SQLite logical-document columns are added through idempotent migrations.
