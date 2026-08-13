# 发布前检查

从仓库根目录运行。Node.js 版本必须落在 `>=24.18.1 <25`，Corepack 使用
pnpm `11.20.0`：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm verify:docs
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

这些命令是本地发布判断的主要证据。没有实时嵌入密钥时，相关测试可以按
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) 的说明跳过，但不能把网络不可用伪装成
通过。

## Rust 检查

```powershell
Set-Location rust-vexus-lite
cargo fmt --check
cargo test
cargo build --release
cargo clippy --all-targets --all-features -- -D warnings
```

Clippy 当前在 CI 中是非阻塞任务；发布前仍应记录它是否实际通过。

## 包内容

发布包应包含 `dist/`、`README.md`、`CHANGELOG.md`、生成的 N-API 加载器和
[NATIVE-MATRIX.md](NATIVE-MATRIX.md) 列出的原生文件；不应包含 `src/`、`tests/`、
`dist-test/`、SQLite 数据库或临时 tarball。

发布前用下面的命令核对公开导出和两种模块入口：

```powershell
node --input-type=module -e "import * as m from './dist/index.js'; console.log(Object.keys(m))"
node --input-type=module -e "import {createRequire} from 'node:module'; const r=createRequire(import.meta.url); console.log(Object.keys(r('./dist/index.cjs')))"
```

如果导出清单发生变化，必须同步检查 [API.md](API.md)、类型声明、消费者测试和变更记录。
数据库文件和向量索引格式的
兼容性也必须通过对应迁移和恢复测试确认。

## GitHub Packages

从 `0.2.0` 开始，npm package identity 是 `@arsvinezhu/memoria`，并由
`package.json` 的 `publishConfig` 指向 GitHub Packages。发布需要 GitHub classic PAT
的 `write:packages` 权限；只在本机临时认证，不要提交 `.npmrc`、token 或其他凭据：

```powershell
npm login --scope=@arsvinezhu --auth-type=legacy --registry=https://npm.pkg.github.com
npm whoami --registry=https://npm.pkg.github.com
npm publish <audited-tarball> --registry=https://npm.pkg.github.com --access public
npm view @arsvinezhu/memoria@0.2.0 --registry=https://npm.pkg.github.com
npm logout --registry=https://npm.pkg.github.com
```

发布和 GitHub Release 必须使用同一个已经审计的 tarball；版本一旦进入 registry，不能
重复发布同一版本。GitHub Release 应附加该 tarball，并核对 registry version、annotated
tag、Release asset 和发布 commit 一致。
