# vexus-lite 原生向量包

`rust-vexus-lite/` 是 memoria 使用的 Rust N-API 向量索引包。它负责提供
`VexusIndex` 及相关原生能力；主引擎通过 TypeScript 的
`src/providers/vexus-vector-store.ts` 接入，不应把本目录当作独立的持久化权威。

## 目录职责

- `src/`：Rust 实现和导出。
- `Cargo.toml`、`Cargo.lock`：Rust 构建和依赖定义。
- `index.js`、`index.d.ts`：N-API 生成的 Node loader 和类型声明。
- 根目录的 `*.node`：随仓库提供的原生平台产物；当前矩阵见
  [原生分发矩阵](../docs/NATIVE-MATRIX.md)。
- `target/`、`node_modules/`：本地构建产物，不提交。

## 本地构建和测试

Rust 命令在本目录运行：

```powershell
cargo fmt --check
cargo test
cargo build --release
```

如果需要用 N-API CLI 生成平台产物：

```powershell
corepack pnpm exec napi build --platform --release
```

当前 CI 的 canonical target 是 Windows x64、Linux x64/arm64 的 glibc 与 musl，及
macOS arm64，共六个平台。跨平台发布由 `.github/workflows/ci.yml` 的
`native-build`、`native-smoke-matrix` 和 `native-artifacts` jobs 完成；汇总 job 使用
`napi artifacts` 收集平台产物，并同时检查 generic artifact、loader 和 declaration。

本地只构建当前主机的通用产物时使用：

```powershell
corepack pnpm exec napi build --release
```

生成或修改原生导出后，在仓库根目录继续运行：

```powershell
corepack pnpm test:native
corepack pnpm verify:pack
```

根项目的 Node.js 支持范围以根 `package.json` 为准；本目录自身的 `package.json`
还声明了 `Node.js >=14` 的本地包引擎范围，二者不要混写成一个兼容性承诺。

修改 ABI、loader、产物名称、平台支持或恢复行为前，先读本目录的
[AGENTS.md](AGENTS.md)、[持久化说明](../docs/PERSISTENCE.md) 和
[原生分发矩阵](../docs/NATIVE-MATRIX.md)。
