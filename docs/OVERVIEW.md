# OVERVIEW — memoria 一句话定位

> **memoria 是一个以 Node.js 为核心、算子级 Stage 编排的多协议记忆中间件**：
> 文件摄取 → 分块嵌入 → 双持久化（SQLite 元数据 + Rust N-API 向量索引）→
> 向量/稀疏双路召回 → 记忆算法提权（TagMemo V10 / RiverMemo V9.1 / EPA /
> 残差金字塔 / 语义去重）→ 结果后处理，并内置 TDB 冷知识库与
> KnowledgeBaseAdapter 兼容层。产品定位见 `README.md`（实现卖点与快速上手见
> `docs/GUIDE.md`）。

## 内容结构（怎么看这套仓库）

| 文件/目录 | 作用 | 阅读顺序 |
|-----------|------|----------|
| `README.md` | 产品卖点 + 快速示例 | 1 |
| `docs/OVERVIEW.md` | 本文档：定位、目录树、文件职责 | 1 |
| `docs/GUIDE.md` | GETTING_STARTED / UPGRADE_MIGRATION / CONFIGURATION / TAG_MEMO_V10 / PLUGIN_ARCHITECTURE | 2 |
| `docs/ARCHITECTURE.md` | 引擎生命周期、三段管线编排、存储链路 | 3 |
| `docs/FUNCTIONS.md` | STAGE 流水线逐阶段文档 + TDB + KBM 兼容面 | 4 |
| `docs/API.md` | `index.js` 全部 41 个导出符号的签名与默认值 | 5 |
| `docs/superpowers/` | 产品设计 spec 与 rollout 计划（溯源） | 按需 |
| `tests/` | 算法 / 管线 / 引擎 / TDB 行为验证 | 与源码对照 |

## 目录树（精简）

```text
memoria/
├─ index.js                 # 单一出口：41 个导出（见 docs/API.md）
├─ src/                     # Node.js 核心源码（无 src/src 分层，按职责分目录）
│  ├─ engine.js             # createMemoryEngine 工厂 + MemoryEngine 生命周期
│  ├─ core/                 # Pipeline / Stage / PipelineContext 抽象
│  ├─ pipelines/            # ingest / search / delete 三段主管线编排
│  ├─ stages/               # 阶段实现（见 docs/FUNCTIONS.md）
│  │  ├─ ingestion/         #   摄取 9 个阶段（读→标签→分块→嵌入→写库→定标）
│  │  ├─ retrieval/         #   检索：queryEmbed → 双路召回 → CandidateMerger
│  │  ├─ memo/              #   记忆：TagMem V10 / V9 / RiverMemo / EPA / 残差
│  │  ├─ postprocess/       #   重排提权 → 去重 → 截断
│  │  ├─ output/            #   结果格式化
│  │  └─ tdb/               #   冷知识库查询链（queryNormalizer / formatter）
│  ├─ algorithms/           # 领域算法：SVD/PCA、Gram-Schmidt、EPA、残差金字塔、
│  │                        #   语义去重、波传播、河流观测、缩放场
│  ├─ providers/            # SqliteMetadataStore / VexusVectorStore /
│  │                        #   OpenAI / Dashscope 嵌入 Provider
│  ├─ interfaces/           # Provider 接口约定
│  ├─ compat/               # KnowledgeBaseAdapter（KBM 兼容层）
│  ├─ tdb/                  # TDB 引擎 / 查询链 / 存储 / TriviumDB 代理
│  ├─ utils/                # 向量编解码 / 文本预处理 / 分块工具
│  └─ config/               # DEFAULT_CONFIG / rag_params 热调参装载
├─ examples/                # demo（fake 嵌入）；real-embed（真实嵌入召回）
├─ tests/                   # algorithms / stages / pipelines / engine / tdb / 集成
├─ rust-vexus-lite/         # Rust N-API 向量索引（usearch 的 build）：日记维度索引 + 全局标签索引
├─ docs/                    # 本文档集
├─ knowledge/               # 冷知识库运行目录（当前为空，首次使用时填充 json 文件）
├─ VectorStoreTDB/          # TDB 向量索引运行目录（首启自动创建）
├─ package.json             # 入口 main=index.js；scripts 含 build（Cargo 构建 Rust）
└─ CHANGELOG.md             # 版本变更记录
```

## 关键文件职责

| 符号/文件 | 位置 | 作用 |
|-----------|------|------|
| `createMemoryEngine` / `MemoryEngine` | `src/engine.js` | 工厂与生命周期（initialize / flush / search / delete / stats / close） |
| `Pipeline` / `Stage` / `PipelineContext` | `src/core/` | 阶段编排抽象与共享 DI 容器 |
| `SqliteMetadataStore` | `src/providers/sqlite-metadata-store.js` | 文件 / 块 / 标签 / file_tags / kv_store 元数据持久化 |
| `VexusVectorStore` | `src/providers/vexus-vector-store.js` | 日记维度索引 + 全局标签索引（Rust N-API） |
| `TagMemo V10` | `src/stages/memo/tagmemo-v10.js` | 关联图记忆重排（scaled fields + sparse over layer） |
| `RiverMemo` | `src/stages/memo/rivermemo.js` | 软非回波河流传播重排（波传播主文档 TS 源码） |
| `EPA` | `src/algorithms/epa.js` | 认知轴线（PCA 基 + 熵 → 领域最大轴 + 能量分类） |
| `ResidualPyramid` | `src/algorithms/residual-pyramid.js` | 残差子空间逐层解耦，扩展信号特征 |
| `ResultDeduplicator` | `src/algorithms/result-deduplicator.js` | 身份 + 语义双层去重（语义阈值默认 0.92） |
| `TDBEngine` | `src/tdb/tdb-engine.js` | 冷知识库引擎（文档摄取 / 检索 / 库管理） |
| `KnowledgeBaseAdapter` | `src/compat/knowledge-base-adapter.js` | KBM 方法面兼容：`flushBatch/search/handleDelete/jobs` 等 |
| Rust `lib.rs` | `rust-vexus-lite/src/lib.rs` | 与 JS 的 N-API 桥梁（usearch 深度召回、日记向量） |

> 权威分工：`docs/FUNCTIONS.md` 逐阶段消费链路、`docs/ARCHITECTURE.md` 管线
> 组合形态、`docs/API.md` 全导出签名。