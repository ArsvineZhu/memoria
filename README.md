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
├── index.js                     # 库导出入口（createMemoryEngine / 算法族 / 工具）
├── src/
│   ├── core/                    # Pipeline / Stage / Context 编排内核
│   ├── engine.js                # MemoryEngine 生命周期（init / flush / search / delete / close）
│   ├── config/                  # DEFAULT_CONFIG 与 mergeConfig
│   ├── pipelines/               # ingest / search / delete 三级主管线
│   ├── stages/                  # ingestion / retrieval / memo / postprocess 算子
│   ├── algorithms/              # EPA / 残差金字塔 / SVD / wave / topology
│   ├── providers/               # 嵌入 Provider + SQLite 元数据 + Rust 向量存储
│   ├── tdb/                     # TDB 冷知识库（TriviumDB 适配）
│   ├── compat/                  # KnowledgeBaseAdapter 兼容面
│   └── interfaces/              # EmbeddingProvider / VectorStore / MetadataStore 契约
├── rust-vexus-lite/             # Rust N-API 原生向量引擎（6 平台预编译二进制）
├── tests/                       # 318 项测试（10 目录，node --test）
├── examples/
│   ├── demo/                    # 离线章节演示（零配置：main.js + fake-embedding.js）
│   └── real-embed/              # 真实嵌入记忆召回演示（demo-recall.js）
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
npm install
node examples/demo/main.js   # 6 章节完整演示：初始化 → 摄取 → 检索 → 删除 → 关闭
```

Rust 向量引擎二进制随仓库分发，**无需本地 Rust 工具链**；如需自行重建，执行
`cd rust-vexus-lite && npm run build`。

也可以用约 20 行代码跑通最小链路（以 `examples/demo` 的真实调用为蓝本）：

```js
const path = require('node:path');
const { createMemoryEngine } = require('memoria');
const { FakeEmbeddingProvider } = require('./examples/demo/fake-embedding');

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

(async () => {
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
})();
```

### 真实嵌入（DashScope / OpenAI 兼容）

在 `examples/real-embed` 下放置 `.env`（`EMBED_API_KEY=sk-xxxx`），然后：

```bash
node examples/real-embed/demo-recall.js
```

它会用真实模型（qwen3.7-text-embedding，1024 维）灌入 10 篇中文文档并执行
6 组难度递增的语义召回（直配 / 同义改写 / 跨主题联想 / 概念等价 / 模糊记忆）。
在自有代码中接入真实嵌入：

```js
const { createMemoryEngine } = require('memoria');
const DashScopeEmbeddingProvider =
  require('./src/providers/dashscope-embedding-provider');
// 亦可用 ./src/providers/openai-embedding-provider（OpenAI 兼容，需 apiUrl）

const engine = createMemoryEngine({
  config: { dimension: 1024, rootPath, storePath, chunkMaxTokens: 600, chunkOverlapTokens: 96 },
  dbPath: path.join(storePath, 'memory.sqlite'),
  embeddingProvider: new DashScopeEmbeddingProvider({
    apiKey: process.env.EMBED_API_KEY,
    model: 'qwen3.7-text-embedding',
    dimension: 1024
  })
});
```

### 兼容层：KnowledgeBaseAdapter

面向既有调用的 drop-in 接口，方法：`initialize / flushBatch / getStats / search /
removeDocument / shutdown`（另有 `runExternalFileMutation`、`getEPAAnalysis` 等扩展面）：

```js
const { createMemoryEngine, KnowledgeBaseAdapter } = require('memoria');
const kb = new KnowledgeBaseAdapter({ engine: createMemoryEngine({ /* ... */ }) });

await kb.initialize();
await kb.flushBatch(docs);                       // [{ path }]
const stats = await kb.getStats();               // { files, chunks, tags, vectorStats }
const out = await kb.search('量子纠缠 叠加态');    // 文本走引擎检索管线
await kb.removeDocument('/abs/path/file.md');     // 移除单个已索引文件
await kb.shutdown();
```

## 示例

| 目录 | 说明 |
|------|------|
| `examples/demo/` | 离线章节演示：`main.js`（6 章节生命周期）+ `fake-embedding.js`（128 维确定性伪嵌入，接口与真实 Provider 一致），`node main.js` 一键运行、结果可复现 |
| `examples/real-embed/` | 真实 API 记忆召回：`demo-recall.js` 用 qwen3.7-text-embedding 灌库 10 篇中文文档并做 6 组语义召回排序（需 `EMBED_API_KEY`，无 key 时脚本友好退出） |

## 文档导航

| 目录 | 主题 |
|------|------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 体系总览：引擎生命周期、管线编排与存储链 |
| [docs/GUIDE.md](docs/GUIDE.md) | 快速上手：安装、配置、最小接入 |
| [docs/FUNCTIONS.md](docs/FUNCTIONS.md) | 完整功能说明：检索 / 记忆体 / 标签 / TDB 全清单 |
| [docs/ALGORITHMS.md](docs/ALGORITHMS.md) | 算法族数学说明：TagMemo 浪潮 / EPA / 残差金字塔 / SVD |
| [docs/EMBEDDING.md](docs/EMBEDDING.md) | 嵌入 Provider 体系：接口契约与三种实现 |
| [docs/PERSISTENCE.md](docs/PERSISTENCE.md) | 持久化与重启恢复：SQLite + Rust 双写盘 / 懒加载 |
| [docs/API.md](docs/API.md) | 导出参考：index.js 全部导出签名 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 常见问题：构建 / 维度不匹配 / 索引恢复 |

## 测试

```bash
npm test
```

318 项测试（10 目录显式列出），其中 4 项 integration 实测为真实 API 冒烟——
无 key 时自动 skip，其余 314 项全量通过；验证覆盖算法、管线、阶段、Provider、
TDB 与兼容层。

## License 与贡献

MIT © 2026 Arsvine Zhu。欢迎提交 issue / PR：请遵循现有代码风格（node --test 无依赖测试），
提交前跑通 `npm test`，并向 CHANGELOG 追加变更说明。