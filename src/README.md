# 源码范围

`src/` 是 memoria TypeScript 主包的源码边界，包含公开入口、引擎生命周期、
管线与阶段、Provider 契约和实现、算法、TDB 冷知识库及通用工具。

## 公开入口

- [`index.ts`](index.ts)：ESM 根入口和公开类型导出。
- [`index.cts`](index.cts)：与 ESM 根入口保持 exact runtime export parity 的 CommonJS facade。
- [`errors.ts`](errors.ts)：`memoria/errors` 子路径的结构化错误契约。
- [`adapters/filesystem-ingestion-adapter.ts`](adapters/filesystem-ingestion-adapter.ts)：文件系统子路径入口。
- `providers/` 下的 OpenAI-compatible embedding 和 reranker Provider 通过 `package.json` 子路径
  `memoria/providers/openai-compatible` 发布。

## 稳定边界

- `engine.ts` 负责引擎生命周期、逻辑文档摄入、搜索、删除和恢复协调。
- `pipelines/` 与 `stages/` 负责按顺序组合摄入、检索、后处理、输出和 TDB 阶段。
- `interfaces/`、`types.ts` 和 `providers/` 定义 Provider、存储和公开数据结构边界。
- `algorithms/` 保持纯计算算法；`tdb/` 负责冷知识库；
  `utils/` 提供文本、MDX、向量和数值工具。
- `native/` 与 `providers/vexus-vector-store.ts` 连接独立的
  [`rust-vexus-lite/`](../rust-vexus-lite/) 原生包。

源码行为以实现、测试、`package.json` 和 CI 为准。公开导出或子路径改变时，
同步检查 [`docs/API.md`](../docs/API.md)、[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)、
相关类型测试和 `index.cts` facade。

## 开发路径

先读：

- [`docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md)：源码布局和扩展点；
- [`docs/API.md`](../docs/API.md)：公开符号和子路径；
- [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)：生命周期、管线和数据权威；
- [`docs/TESTING.md`](../docs/TESTING.md)：完整验证命令。

仓库根目录的常用检查包括：

```powershell
corepack pnpm verify:docs
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

`dist/`、`dist-test/`、运行时数据库、向量索引和 `eval/` 不是 `src/` 的编辑目标。
