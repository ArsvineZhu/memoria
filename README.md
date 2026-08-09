# memoria — 面向 AI 应用的持久化语义记忆系统

> 向量检索 + 标签浪潮 + 拓扑记忆 + 冷知识库，Node.js 核心 + Rust N-API 原生向量引擎。
> 内置 TagMemo 浪潮激活、RiverMemo 拓扑记忆、EPA 语义分析、残差金字塔与 TDB 冷知识库，
> 通过统一的 `createMemoryEngine` 入口交付"摄入 → 检索 → 记忆"完整链路。

## 特性矩阵

| 能力                      | 说明                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| 向量 + BM25 混合检索      | 多路召回按权重融合（`vectorWeight` / `bm25Weight`），兼顾语义与词面命中                               |
| TagMemory 浪潮激活        | 标签能量沿波传播（V9 波传播 / V10 双尺度场解算），关联标签联想唤醒                                    |
| RiverMemory 拓扑记忆      | scaled-field 双尺度场求解 + 河流可见性（`computeRiverObservability`），记忆衰减可控                   |
| EPA 语义分析              | 正交语义基投影，输出逻辑深度 / 主轴 / 跨域共振（`EPA.computeBasis` + `project`）                      |
| 残差金字塔覆盖            | 多分辨率残差分解，逐层解释查询能量，输出覆盖率与新颖度                                                |
| 自动标签提取与聚类        | 摄取阶段自动抽标签，SVD / 加权 PCA / 幂法聚类成语义基                                                 |
| TDB 冷知识库（TriviumDB） | 独立检索管线（`TDBEngine` + `TDBSearchPipeline`），长尾冷知识周期复习入口                             |
| SQLite + Rust 双持久化    | SQLite 存元数据、Rust N-API 索引存向量，双写盘 + 懒加载磁盘恢复                                       |
| Provider 抽象             | 统一 `EmbeddingProvider` 接口：DashScope 原生 / OpenAI 兼容 / 离线伪嵌入                              |
| Rust N-API 原生向量引擎   | `rust-vexus-lite`：随包分发当前仓库携带的预编译 `.node` 变体；加载器仍保持独立 CommonJS package scope |

## 架构概览

核心是一个**算子级 stage 编排管线**（`Pipeline` / `Stage` / `PipelineContext`），
三大管线（ingest / search / delete）由可插拔 stage 串联；记忆侧算法
（TagMemo / RiverMemo / EPA / 残差金字塔）以阶段产物注入检索结果；
底层由 SQLite 元数据存储与 Rust N-API 向量索引双持久化支撑。

```text
memoria/
├── src/index.ts                 # TypeScript ESM 源入口
├── dist/index.js                # 编译后的 ESM 库入口
├── dist/index.cjs              # 既有 require('memoria') 兼容 facade
├── src/
│   ├── core/                    # Pipeline / Stage / Context 编排内核
│   ├── engine.ts                # MemoryEngine 生命周期（init / flush / search / delete / close）
│   ├── config/                  # DEFAULT_CONFIG 与 mergeConfig
│   ├── pipelines/               # ingest / search / delete 三级主管线
│   ├── stages/                  # ingestion / retrieval / memo / postprocess 算子
│   ├── algorithms/              # EPA / 残差金字塔 / SVD / wave / topology
│   ├── providers/               # 嵌入 Provider + SQLite 元数据 + Rust 向量存储
│   ├── tdb/                     # TDB 冷知识库（TriviumDB 适配）
│   ├── compat/                  # KnowledgeBaseAdapter 兼容面
│   └── interfaces/              # EmbeddingProvider / VectorStore / MetadataStore 契约
├── rust-vexus-lite/             # Rust N-API 原生向量引擎（6 平台预编译二进制）
├── tests/                       # TypeScript 测试源（编译到 dist-test/ 后由 node --test 执行）
├── examples/
│   ├── demo/                    # 离线章节演示（零配置：main.ts + fake-embedding.ts）
│   └── real-embed/              # 真实嵌入记忆召回演示（demo-recall.ts）
├── docs/                        # 文档导航见下表
├── knowledge/                   # TDB 运行期知识目录（运行时 I/O）
├── VectorStoreTDB/              # TDB 向量库运行目录（运行时 I/O）
├── LICENSE                      # MIT © 2026 Arsvine Zhu
└── CHANGELOG.md
```

## 快速开始

### 离线运行（零配置、零网络）

```bash
git clone <你的仓库地址> && cd memoria
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm build
corepack pnpm build:test
node dist-test/examples/demo/main.js   # 6 章节完整演示：初始化 → 摄取 → 检索 → 删除 → 关闭
```

Rust 向量引擎二进制随仓库分发，**无需本地 Rust 工具链**；如需自行重建，执行
`cd rust-vexus-lite && corepack pnpm exec napi build --platform --release`。

核心摄入 API 以逻辑内容为中心，不要求 filesystem path：

```ts
import { createMemoryEngine } from "memoria";
import { FakeEmbeddingProvider } from "./examples/demo/fake-embedding.js";

const engine = createMemoryEngine({
  config: {
    dimension: 128,
    storePath: "./indices",
    topK: 3,
    tagMemoV9Enabled: true,
    epaProjectionEnabled: true,
    residualPyramidEnabled: true,
  },
  dbPath: "./memory.sqlite",
  embeddingProvider: new FakeEmbeddingProvider(128),
});

async function main(): Promise<void> {
  await engine.initialize();
  await engine.ingest({
    id: "demo:coffee",
    content: "手冲咖啡的萃取参数与水温记录。",
    source: { type: "demo" },
    revision: "1",
    metadata: { topic: "coffee" },
  });
  const stats = await engine.getStats();
  console.log(
    `已入库：文档 ${stats.files}｜块 ${stats.chunks}｜向量 ${stats.vectorStats.totalVectors}`,
  );

  const out = await engine.search("手冲 萃取参数", { topK: 3 });
  for (const result of out.results)
    console.log(`[${result.score}] ${result.documentId}: ${result.content}`);

  await engine.remove("demo:coffee");
  await engine.close();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

filesystem 摄入保留为 adapter；它负责读取文件、扫描和 watcher，再把完整快照交给引擎：

```ts
import { createMemoryEngine } from "memoria";
import FilesystemIngestionAdapter from "memoria/adapters/filesystem";

const engine = createMemoryEngine({
  config: { rootPath: "./notes", storePath: "./indices" },
});
const files = new FilesystemIngestionAdapter(engine, {
  rootPath: "./notes",
  extensions: [".md"],
});

await engine.initialize();
await files.scan();
await files.start();
// ...让 watcher 接收变更...
await files.close();
await engine.close();
```

### 真实嵌入（DashScope / OpenAI 兼容）

在 `examples/real-embed` 下放置 `.env`（`EMBED_API_KEY=sk-xxxx`），然后：

```bash
corepack pnpm build:test
node dist-test/examples/real-embed/demo-recall.js
```

它会用真实模型（qwen3.7-text-embedding，1024 维）灌入 10 篇中文文档并执行
6 组难度递增的语义召回（直配 / 同义改写 / 跨主题联想 / 概念等价 / 模糊记忆）。
在自有代码中接入真实嵌入：

```ts
import { join } from "node:path";

import { createMemoryEngine } from "memoria";
import DashScopeEmbeddingProvider from "memoria/providers/dashscope";
// OpenAI 兼容 provider：import OpenAIEmbeddingProvider from "memoria/providers/openai";

const rootPath = join(process.cwd(), "notes");
const storePath = join(process.cwd(), "indices");

const engine = createMemoryEngine({
  config: {
    dimension: 1024,
    rootPath,
    storePath,
    chunkMaxTokens: 600,
    chunkOverlapTokens: 96,
  },
  dbPath: join(storePath, "memory.sqlite"),
  embeddingProvider: new DashScopeEmbeddingProvider({
    apiKey: process.env.EMBED_API_KEY ?? "",
    model: "qwen3.7-text-embedding",
    dimension: 1024,
  }),
});
```

### 兼容层：KnowledgeBaseAdapter

面向既有调用的 drop-in 接口，方法：`initialize / flushBatch / getStats / search /
removeDocument / shutdown`（另有 `runExternalFileMutation`、`getEPAAnalysis` 等扩展面）：

```ts
import { createMemoryEngine, KnowledgeBaseAdapter } from "memoria";

async function main(): Promise<void> {
  const kb = new KnowledgeBaseAdapter({ engine: createMemoryEngine({/* ... */}) });
  const docs: Array<{ path: string }> = [{ path: "/abs/path/file.md" }];

  await kb.initialize();
  await kb.flushBatch(docs); // [{ path }]
  const stats = await kb.getStats(); // { files, chunks, tags, vectorStats }
  const out = await kb.search("量子纠缠 叠加态"); // 文本走引擎检索管线
  await kb.removeDocument("/abs/path/file.md"); // 移除单个已索引文件
  await kb.shutdown();
  void stats;
  void out;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

## 示例

| 目录                   | 说明                                                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `examples/demo/`       | 离线章节演示：`main.ts`（6 章节生命周期）+ `fake-embedding.ts`（128 维确定性伪嵌入，接口与真实 Provider 一致），编译后从 `dist-test/examples/demo/main.js` 运行                        |
| `examples/real-embed/` | 真实 API 记忆召回：`demo-recall.ts` 用 qwen3.7-text-embedding 灌库 10 篇中文文档并做 6 组语义召回排序（需 `EMBED_API_KEY`，编译后运行 `dist-test/examples/real-embed/demo-recall.js`） |

## 文档导航

| 目录                                                   | 主题                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)           | 体系总览：引擎生命周期、管线编排与存储链                               |
| [docs/GUIDE.md](docs/GUIDE.md)                         | 快速上手：安装、配置、最小接入                                         |
| [docs/FUNCTIONS.md](docs/FUNCTIONS.md)                 | 完整功能说明：检索 / 记忆体 / 标签 / TDB 全清单                        |
| [docs/ALGORITHMS.md](docs/ALGORITHMS.md)               | 算法族数学说明：TagMemo 浪潮 / EPA / 残差金字塔 / SVD                  |
| [docs/EMBEDDING.md](docs/EMBEDDING.md)                 | 嵌入 Provider 体系：接口契约与三种实现                                 |
| [docs/PERSISTENCE.md](docs/PERSISTENCE.md)             | 持久化与重启恢复：SQLite + Rust 双写盘 / 懒加载                        |
| [docs/API.md](docs/API.md)                             | 根入口 41 个导出、逻辑摄入 API、adapter/error 子路径与 TypeScript 类型 |
| [docs/NATIVE-MATRIX.md](docs/NATIVE-MATRIX.md)         | 实际随包分发的 N-API 二进制矩阵与 smoke 验证                           |
| [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md) | 发布前工具链、公共边界与 tarball 验收清单                              |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)     | 常见问题：构建 / 维度不匹配 / 索引恢复                                 |

## 测试

```bash
corepack pnpm test
```

测试数量以当前命令的实际输出为准；没有 `EMBED_API_KEY` 时，真实 API 集成测试会明确 skip，
不会把网络不可用伪装成通过。验证覆盖算法、管线、阶段、Provider、TDB、兼容层、逻辑摄入、
filesystem adapter、恢复和打包 consumer。

## License 与贡献

MIT © 2026 Arsvine Zhu。欢迎提交 issue / PR：请遵循现有代码风格（node --test 无依赖测试），
提交前跑通 `corepack pnpm format:check && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build`，
并向 CHANGELOG 追加变更说明。
