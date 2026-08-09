# memoria — 面向 AI 应用的持久化语义记忆系统

> 向量检索 + 标签浪潮 + 拓扑记忆 + 冷知识库，Node.js 核心 + Rust N-API 原生向量引擎。
> 内置 TagMemo 浪潮激活、RiverMemo 拓扑记忆、EPA 语义分析、残差金字塔与 TDB 冷知识库，
> 通过统一的 `createMemoryEngine` 入口交付"摄入 → 检索 → 记忆"完整链路。

## 特性矩阵

| 能力 | 说明 |
|------|------|
| 向量 + BM25 混合检索 | 多路召回按权重融合（`vectorWeight` / `bm25Weight`），兼顾语义与词面命中 |
| TagMemory 浪潮激活 | 标签能量沿波传播（V9 波传播 / V10 双尺度场解算），关联标签联想唤醒 |
| RiverMemory 拓扑记忆 | scaled-field 双尺度场求解 + 河流可见性（`computeRiverObservability`），记忆衰减可控 |
| EPA 语义分析 | 正交语义基投影，输出逻辑深度 / 主轴 / 跨域共振（`EPA.computeBasis` + `project`） |
| 残差金字塔覆盖 | 多分辨率残差分解，逐层解释查询能量，输出覆盖率与新颖度 |
| 自动标签提取与聚类 | 摄取阶段自动抽标签，SVD / 加权 PCA / 幂法聚类成语义基 |
| TDB 冷知识库（TriviumDB） | 独立检索管线（`TDBEngine` + `TDBSearchPipeline`），长尾冷知识周期复习入口 |
| SQLite + Rust 双持久化 | SQLite 存元数据、Rust N-API 索引存向量，双写盘 + 懒加载磁盘恢复 |
| Provider 抽象 | 统一 `EmbeddingProvider` 接口：DashScope 原生 / OpenAI 兼容 / 离线伪嵌入 |
| Rust N-API 原生向量引擎 | `rust-vexus-lite`：6 平台预编译二进制（darwin-arm64 / linux x64+arm64 gnu+musl / win32-x64） |

## 架构概览

核心是一个**算子级 stage 编排管线**（`Pipeline` / `Stage` / `PipelineContext`），
三大管线（ingest / search / delete）由可插拔 stage 串联；记忆侧算法
（TagMemo / RiverMemo / EPA / 残差金字塔）以阶段产物注入检索结果；
底层由 SQLite 元数据存储与 Rust N-API 向量索引双持久化支撑。

```text
memoria/
├── index.ts                     # TypeScript 源入口（保留 CommonJS 导出面）
├── dist/index.js                # 编译后的 CommonJS 库入口
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
npm ci
npm run typecheck
npm run build
npm run build:test
node dist-test/examples/demo/main.js   # 6 章节完整演示：初始化 → 摄取 → 检索 → 删除 → 关闭
```

Rust 向量引擎二进制随仓库分发，**无需本地 Rust 工具链**；如需自行重建，执行
`cd rust-vexus-lite && npm run build`。

也可以用约 20 行代码跑通最小链路（以 `examples/demo` 的真实调用为蓝本）：

```ts
import path = require('node:path');

import { createMemoryEngine } from 'memoria';
import { FakeEmbeddingProvider } from './examples/demo/fake-embedding';

const engine = createMemoryEngine({
  config: {
    dimension: 128,                              // 与提供者维度一致
    rootPath: path.join(__dirname, 'notes'),     // 扫描目录
    storePath: path.join(__dirname, 'indices'),  // 向量索引落盘目录
    topK: 3,
    tagMemoV9Enabled: true,                      // TagMemo 浪潮
    epaProjectionEnabled: true,                  // EPA 语义投影
    residualPyramidEnabled: true                 // 残差金字塔
  },
  dbPath: path.join(__dirname, 'memory.sqlite'), // SQLite 元数据
  embeddingProvider: new FakeEmbeddingProvider(128) // 离线确定性伪嵌入
});

async function main(): Promise<void> {
  await engine.initialize();
  await engine.flushBatch([
    { path: path.join(__dirname, 'notes', 'life', 'coffee.md') }
  ]);
  const stats = await engine.getStats();
  console.log(`已入库：文件 ${stats.files}｜块 ${stats.chunks}｜向量 ${stats.vectorStats.totalVectors}`);

  const out = await engine.search('手冲 萃取参数', { topK: 3 });
  for (const r of out.results || []) console.log(`[${r.score}] ${r.sourceFile}: ${r.content}`);

  await engine.handleDelete({ path: path.join(__dirname, 'notes', 'life', 'coffee.md') });
  await engine.close();
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
```

### 真实嵌入（DashScope / OpenAI 兼容）

在 `examples/real-embed` 下放置 `.env`（`EMBED_API_KEY=sk-xxxx`），然后：

```bash
npm run build:test
node dist-test/examples/real-embed/demo-recall.js
```

它会用真实模型（qwen3.7-text-embedding，1024 维）灌入 10 篇中文文档并执行
6 组难度递增的语义召回（直配 / 同义改写 / 跨主题联想 / 概念等价 / 模糊记忆）。
在自有代码中接入真实嵌入：

```ts
import path = require('node:path');

import { createMemoryEngine } from 'memoria';
import DashScopeEmbeddingProvider = require('./src/providers/dashscope-embedding-provider');
// 亦可用 ./src/providers/openai-embedding-provider（OpenAI 兼容，需 apiUrl）

const rootPath = path.join(__dirname, 'notes');
const storePath = path.join(__dirname, 'indices');

const engine = createMemoryEngine({
  config: { dimension: 1024, rootPath, storePath, chunkMaxTokens: 600, chunkOverlapTokens: 96 },
  dbPath: path.join(storePath, 'memory.sqlite'),
  embeddingProvider: new DashScopeEmbeddingProvider({
    apiKey: process.env.EMBED_API_KEY ?? '',
    model: 'qwen3.7-text-embedding',
    dimension: 1024
  })
});
```

### 兼容层：KnowledgeBaseAdapter

面向既有调用的 drop-in 接口，方法：`initialize / flushBatch / getStats / search /
removeDocument / shutdown`（另有 `runExternalFileMutation`、`getEPAAnalysis` 等扩展面）：

```ts
import { createMemoryEngine, KnowledgeBaseAdapter } from 'memoria';

async function main(): Promise<void> {
  const kb = new KnowledgeBaseAdapter({ engine: createMemoryEngine({ /* ... */ }) });
  const docs: Array<{ path: string }> = [
    { path: '/abs/path/file.md' }
  ];

  await kb.initialize();
  await kb.flushBatch(docs);                       // [{ path }]
  const stats = await kb.getStats();               // { files, chunks, tags, vectorStats }
  const out = await kb.search('量子纠缠 叠加态');    // 文本走引擎检索管线
  await kb.removeDocument('/abs/path/file.md');     // 移除单个已索引文件
  await kb.shutdown();
  void stats;
  void out;
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
```

## 示例

| 目录 | 说明 |
|------|------|
| `examples/demo/` | 离线章节演示：`main.ts`（6 章节生命周期）+ `fake-embedding.ts`（128 维确定性伪嵌入，接口与真实 Provider 一致），编译后从 `dist-test/examples/demo/main.js` 运行 |
| `examples/real-embed/` | 真实 API 记忆召回：`demo-recall.ts` 用 qwen3.7-text-embedding 灌库 10 篇中文文档并做 6 组语义召回排序（需 `EMBED_API_KEY`，编译后运行 `dist-test/examples/real-embed/demo-recall.js`） |

## 文档导航

| 目录 | 主题 |
|------|------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 体系总览：引擎生命周期、管线编排与存储链 |
| [docs/GUIDE.md](docs/GUIDE.md) | 快速上手：安装、配置、最小接入 |
| [docs/FUNCTIONS.md](docs/FUNCTIONS.md) | 完整功能说明：检索 / 记忆体 / 标签 / TDB 全清单 |
| [docs/ALGORITHMS.md](docs/ALGORITHMS.md) | 算法族数学说明：TagMemo 浪潮 / EPA / 残差金字塔 / SVD |
| [docs/EMBEDDING.md](docs/EMBEDDING.md) | 嵌入 Provider 体系：接口契约与三种实现 |
| [docs/PERSISTENCE.md](docs/PERSISTENCE.md) | 持久化与重启恢复：SQLite + Rust 双写盘 / 懒加载 |
| [docs/API.md](docs/API.md) | 导出参考：`dist/index.js` 的全部导出与 TypeScript 类型 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 常见问题：构建 / 维度不匹配 / 索引恢复 |

## 测试

```bash
npm test
```

当前编译后测试共 319 项：315 项通过、4 项真实 API 冒烟因无 key 自动 skip、0 项失败。
其中相对迁移前基线（314 通过、4 skip）新增 1 项公共导出面类型/运行时兼容测试；验证覆盖
算法、管线、阶段、Provider、TDB 与兼容层。

## License 与贡献

MIT © 2026 Arsvine Zhu。欢迎提交 issue / PR：请遵循现有代码风格（node --test 无依赖测试），
提交前跑通 `npm test`，并向 CHANGELOG 追加变更说明。
