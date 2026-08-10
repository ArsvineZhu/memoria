# ARCHITECTURE — memoria 架构总览

> 本文档描述 memoria（Node.js 产品化记忆系统）的整体架构：引擎生命周期、
> 管线编排、分层组件与存储链路。所有组件名、阶段名、默认值均以仓库源码为准。

## 1. 总体设计

memoria 的核心是一个**算子级 stage 编排管线**：三段主管线（ingest / search /
delete）由可插拔 `Stage` 串联，所有阶段共享一个 `PipelineContext`（依赖注入容器）
读配置、取 Provider。主 ingest 契约是无路径的 `MemoryDocumentInput`；文件读取、
扫描与 watcher 位于独立的 `FilesystemIngestionAdapter`。SQLite 元数据与内容是权威
状态，Rust N-API 向量索引（VexusIndex，日记维度索引 + 共享标签索引）是可重建的派生
状态。文件系统源默认位于托管的 `data/content/`，推荐使用带 YAML front matter
的 MDX；摄取时只解析 front matter，正文和 MDX/JSX 语法仍作为纯文本。

```
                    ┌────────────────────────────────────────────┐
                    │             MemoryEngine (engine.ts)        │
                    │  config │ providers │ ctx │ 3 pipelines     │
                    └───────┬────────────────────────────┬───────┘
             flushBatch ────┤                            ├── search / handleDelete
                            ▼                            ▼
              ┌────────────────────┐          ┌────────────────────┐
              │   IngestPipeline   │          │ SearchPipeline     │
              │   摄入阶段串行执行  │          │ 检索与后处理按开关组合 │
              │   read→tags→chunk  │          │ 并在末端统一格式化     │
              │   →embed→write→vec │          └────────────────────┘
              └───────┬────┬──────┘
                      ▼    ▼
          ┌────────────────────┐
          │ SqliteMetadataStore│   VexusVectorStore（Rust N-API）
          │  files/chunks/tags │   data/memoria/indexes/
          │  file_tags/kv_store│
          └────────────────────┘
```

### 托管数据边界

默认 `dataPath` 是 `<cwd>/data`，路径契约如下：

```text
data/
├─ content/                  # MDX 原始源文件（权威、可版本控制）
├─ knowledge/                # 可选 TDB 原始源文件
├─ memoria/
│  ├─ memory.sqlite           # 主引擎 SQLite 权威状态
│  └─ indexes/                # 主引擎可重建向量索引
└─ tdb/
   ├─ knowledge.sqlite        # TDB SQLite 权威状态
   └─ indexes/                # TDB 可重建向量索引
```

`data/content/**/*.mdx` 是推荐的原始数据标准。front matter 的 `tags` 进入标签
管线，其他键进入现有 `files.metadata_json`；front matter 不参与 chunk/embedding，
因此只改元数据可以复用正文向量。SQLite 保存文件、块、标签和持久向量 BLOB，
`.usearch` 仅是派生缓存，缺失或损坏时由 SQLite authority 重建。

## 2. MemoryEngine 生命周期

`createMemoryEngine(options)` 是唯一工厂入口（`src/engine.ts`；发布产物为 `dist/engine.js`）：

```
createMemoryEngine({config, dbPath, embeddingProvider, ...})
  │
  ├─ 1. mergeConfig(DEFAULT_CONFIG)          ← config 与默认值合并（一层深合并）
  ├─ 2. 保存 options、注入的 Provider 与 pipeline definitions
  │      不创建默认 SQLite/Vexus/OpenAI backend，也不打开 native addon
  ├─ 3. 创建三条管线定义（IngestPipeline / DeletePipeline / SearchPipeline）
  └─ 4. state=created；PipelineContext 等待 initialize() 绑定实际 Provider

initialize()        ── 幂等：按需 dynamic import 并创建缺失 Provider → 加载
                       rag_params.json（可选）并应用热调参 → 读取 generation/dirty
                       状态；clean 且 persisted indexes 可验证时直接加载并注册它们，
                       dirty/stale/missing/corrupt 时 reset derived vector state 后
                       从 SQLite authority 批量重建；`persistTagIndex=false` 的 clean
                       path 只局部重建内存 `global_tags` → onReady 回调 → ready
ingest(document)    ── 逻辑内容摄入；按稳定 documentId 幂等 upsert
ingestBatch(docs)   ── 顺序执行逻辑内容摄入
remove(documentId)  ── 按逻辑身份删除，不依赖源文件路径
flushBatch(files)   ── 文件快照入口；Filesystem adapter 优先将完整快照交给它
flush(files)        ── flushBatch 别名（兼容 KBM 调用形状）
search(query)       ── 混合检索；query 可为字符串或 {query, options}
handleDelete()      ── 删除单文件（行 + 块级联 + 日记索引向量清除）
deleteFile()        ── handleDelete 的便捷别名
getStats()          ── { files, chunks, tags, diaries, lastIndexed,
                        vectorStats, healthy, initialized }
close()             ── 幂等：等待 mutation queue → flushPendingSaves() → 成功后
                       mark vector state clean → 关闭 SQLite；flush/close failure
                       通过 lifecycle error 传播并保留可重试状态
```

### 初始化时序细节

1. **构造期（同步）**：配置合并 → 保存注入项与 options → 注册管线及全部默认阶段。
   此时不创建默认 Provider、不打开 SQLite、不加载 `rust-vexus-lite`；引擎状态为
   `created`。
2. **initialize()（异步，幂等）**：并发调用共享同一次执行（`_initPromise`）：
   按需 dynamic import 并创建缺失 Provider → 绑定 `PipelineContext` → 读
   `rag_params.json` → `_applyRagParamsToConfig` → 读取 generation/dirty。clean
   fast path 调用 `restorePersistedIndexes()`，由 Vexus 将所有 expected index
   原子加载并注册到内存 Map；验证失败或状态 dirty/stale 时以已校验的 authority
   plan 调用 `rebuildDerivedState(plan)`，或用 `resetDerivedState()` +
   `replaceIndex()` 重建并 flush。缺少完整能力时保持 dirty 并失败。
3. **摄入时序（单文档/单文件）**：逻辑文档由引擎生成确定性内部路径并带上
   `documentId`、`revision`、source 与 metadata；文件快照由 `FilesystemIngestionAdapter`
   在交给引擎前读取并做稳定性检查；target 同时提供文件与逻辑两组方法时优先
   `flushBatch/handleDelete`，从而保留 `relPath` 与 diary 语义。随后按源码注册顺序执行摄入阶段，最后
   `CooccurrenceBuilderStage`（默认 no-op）。**双写盘次序**：内置
   在交给引擎前读取并做稳定性检查。随后按源码注册顺序执行摄入阶段，最后
   `CooccurrenceBuilderStage`（默认有意跳过派生图重建，开启
   `cooccurrenceRebuild` 或由调用方注入 `ctx.tagGraph` 时才提供共现图）。**双写盘次序**：内置
   在交给引擎前读取并做稳定性检查；target 同时提供文件与逻辑两组方法时优先
   `flushBatch/handleDelete`，从而保留 `relPath` 与 diary 语义。随后按源码注册顺序执行摄入阶段，最后
   `CooccurrenceBuilderStage`（默认有意跳过派生图重建，开启
   `cooccurrenceRebuild` 或由调用方注入 `ctx.tagGraph` 时才提供共现图）。**双写盘次序**：内置
   `SqliteMetadataStore` 的 `MetadataWriterStage` 通过单事务
   `replaceDocumentState()` 原子替换 file/chunks/tags/file_tags，并增加 metadata
   generation、置 `vector_dirty=1`；标签-only 更新使用
   `replaceDocumentTags()` 原子改写 metadata/tags/file_tags 并保留 chunks，缺少
   该能力时在写入前失败。第三方旧 store 才走兼容 CRUD 路径。随后
   `VectorIndexerStage` 更新向量（先删遗留向量再 upsert，日记索引 + global_tags
   标签索引），并触发 `scheduleIndexSave`（延迟落盘）。检索增强阶段的开关、依赖和
   实际诊断字段见 [检索能力矩阵](RETRIEVAL_FEATURES.md)。
4. **shutdown**：`close()` 等待 keyed mutation queue，flush 全部内存向量索引；
   只有 flush 成功且 vector state 完整时才把 generation 标记 clean，之后关闭内置
   SQLite。任一步 flush/close failure 都会形成 lifecycle failure；若资源仍可重试，
   引擎回到 `ready`，不会伪装成 clean/closed。

### 可靠性不变量（MemoryEngine 与 TDBEngine 共用）

- SQLite authority commits atomically：权威文件、分块、向量 BLOB（以及主引擎的标签关系）在单事务内提交。
- Partial embeddings never commit：嵌入批次缺项、维度错误或非有限值时，事务不会写入新的文档版本。
- Persisted vector indexes are derived/rebuildable；权威 SQLite 内容足以重建向量索引。
- 稳定读可以并发执行；待处理的 mutation/reconciliation 会阻止新的读进入，
  不同 mutation identity 仍可并发。stable read 回调重新发起 mutation 时会以
  `MemoriaError("concurrency")` 快速失败，避免等待环。
- Persisted dirty state is separate from current in-memory completeness：磁盘 generation/dirty 标记与本次进程的向量完整性分别维护。
- A failed vector mutation blocks normal vector search until reconciliation；失败后的搜索先完成恢复。
- Reconciliation plans authority state before destructive reset：读取、解码和校验计划成功前，不清空当前 live index。
- Shutdown rejects new operations and drains already-started public operations：进入 `closing` 后不接收新操作，已开始的操作完成后才关闭资源。
- Explicit search scope applies to every retrieval source；vector、BM25 与最终 hydration 使用同一解析范围。
- No explicit scope means all authoritative content indexes/libraries；仅在 scope discovery 不可用时才使用 `Root` compatibility fallback。
- Time decay has exactly one owner: `TimeDecayStage`；关闭时执行零次，开启时执行一次。

TDB 的 `chunks.vector` 列通过幂等 migration 加入旧库。旧行没有可信向量时，初始化会执行一次受校验的 embedding backfill；backfill 失败会保持 dirty 并让初始化失败，不会报告虚假的 `ready`。

## 3. 组件分层

| 层         | 目录              | 职责                 | 关键成员                                                                                                                                        |
| ---------- | ----------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Core       | `src/core/`       | 管线编排内核         | `Pipeline`（串行执行 / pipe / replace）、`Stage`（抽象 process）、`PipelineContext`（DI 容器）                                                  |
| 配置       | `src/config/`     | 全量默认参数 + 加载  | `DEFAULT_CONFIG`、`mergeConfig`、`loadRagParams` / `loadRagParamsSync` / `RAG_PARAMS_DEFAULTS`                                                  |
| Compat     | `src/compat/`     | 老调用面兼容         | `KnowledgeBaseAdapter`（KBM drop-in 封装；`db` / `config` / 派发式 `search` / `runExternalFileMutation` 等）                                    |
| Stages     | `src/stages/`     | 按功能分目录的算子群 | ingestion、retrieval、memo、postprocess、output、tdb 阶段                                                                                       |
| Pipelines  | `src/pipelines/`  | 阶段组合             | `IngestPipeline` / `SearchPipeline` / `DeletePipeline`                                                                                          |
| Providers  | `src/providers/`  | 存储与嵌入实现       | `SqliteMetadataStore`、`VexusVectorStore`、`OpenAIEmbeddingProvider`、`DashScopeEmbeddingProvider`                                              |
| Interfaces | `src/interfaces/` | 三方契约（抽象类）   | `EmbeddingProvider` / `VectorStore` / `MetadataStore`                                                                                           |
| Algorithms | `src/algorithms/` | 纯数学算法（零 I/O） | EPA、ResidualPyramid、ResultDeduplicator + gram-schmidt / svd / wave + topology/                                                                |
| TDB        | `src/tdb/`        | 冷知识库引擎         | `TDBEngine` / `TDBSearchPipeline` / `TDBStore` / `TriviumDBAdapter`                                                                             |
| Utils      | `src/utils/`      | 通用工具             | `mdx-document`（YAML front matter）、`text-chunker`（tiktoken 智能分块）、`text-preprocessor`（清洗 + 标签提取）、`vector-codec`（BLOB 编解码） |

## 4. 检索主链路（SearchPipeline，真实阶段名）

```
search(query, options)
  │
  ├─[1] queryEmbedder        查询嵌入（含查询扩展 queryExpansion、epsilon 掩码）
  ├─[2] queryVectorBridge    发布主查询向量（内部阶段，无同名文件）
  ├─[3] searchScopeResolver   解析一次权威索引范围，供所有召回源复用
  ├─[4] vectorSearcher       向量召回（日记索引逐源 KNN，按 topK 合并）
  ├─[5] bm25Searcher         BM25 稀疏召回（同一解析范围，按 bm25PoolK 截断）
  ├─[6] candidateMerger      融合：双路归一化到 [0,1] → 加权和（vectorWeight +
  │                            bm25Weight）→ 去重 → minScore → topK 截断
  │
  ├─[7] epaProjector         ● EPA 语义深度信号（投影 / 主轴 / 共振）
  ├─[8] residualPyramid      ● 残差金字塔分解（覆盖度 / 新颖度）
  ├─[9] tagMemoV9            标签波传播（浪潮激活）           [配置门]
  ├─[10] tagMemoV10           双尺度场扩散（V10）              [配置门]
  ├─[11] riverMemo            河流状态累计 + 机态重排            [配置门]
  ├─[12] tagExpander         标签驱动候选扩展                  [配置门]
  ├─[13] vectorReshaper      余弦向量重排                      [配置门]
  │
  ├─[14] geodesicReranker    TagMemo 能量场测地线重排          [配置门]
  ├─[15] resultDeduplicator  ● 硬去重 + 语义去重（阈值 0.92）
  ├─[16] externalReranker    LLM/外部排序器                    [配置门]
  ├─[17] timeDecay           时效衰减 0.5^(age/半衰期)          [配置门]
  ├─[18] truncator           topK / 内容长度截断               [配置门]
  ├─[19] expander            同文件关联块扩展                  [配置门]
  │
  ├─[20] associator          标签共现 + 向量邻居关联            [配置门]
  └─[21] resultFormatter     结果信封（格式化 + 元数据补全）→ results/resultCount
```

- ● = 默认开启（`epaProjectionEnabled=true`、`residualPyramidEnabled=true`、
  `dedupeEnabled=true`）；geodesic 与 associator 以及其余增强阶段默认关闭，
  以对应配置门开启。
- 即使 `dedupeEnabled=false`，去重阶段仍在链中（内部自行决定跳过）；`resultFormatter`
  恒为末阶段。

## 5. 目录树对照

实际仓库结构（`Get-ChildItem -Recurse` 核对）与架构映射：

```text
memoria/
├── data/
│   ├── content/               # MDX 原始源文件（默认 rootPath）
│   ├── knowledge/             # TDB 原始源文件
│   ├── memoria/               # 主 SQLite + indexes 派生状态（Git 忽略）
│   └── tdb/                   # TDB SQLite + indexes 派生状态（Git 忽略）
├── src/index.ts                 # TypeScript ESM 源入口
├── src/index.cts                # 兼容 require('memoria') 的 CJS facade
├── dist/index.js                # 编译后的 ESM 库入口
├── dist/index.cjs               # 既有 CommonJS 导入兼容入口
├── src/
│   ├── core/                    # pipeline.ts / stage.ts / context.ts
│   ├── engine.ts                # MemoryEngine 生命周期 + createMemoryEngine 工厂
│   ├── config/
│   │   ├── default-config.ts    # DEFAULT_CONFIG（全量默认参数）+ mergeConfig
│   │   └── rag-params-loader.ts # rag_params.json 热调参加载
│   ├── pipelines/
│   │   ├── ingest-pipeline.ts   # 摄入阶段组合
│   │   ├── search-pipeline.ts   # 按 gate 裁剪的混合检索链
│   │   └── delete-pipeline.ts   # 单阶段（file-deleter）
│   ├── stages/
│   │   ├── ingestion/           # file-reader, tag-extractor, text-chunker,
│   │   │                        # chunk-embedder, tag-embedder, metadata-writer,
│   │   │                        # vector-indexer, co-occurrence-builder, file-deleter
│   │   ├── retrieval/           # query-embedder, vector-searcher, bm25-searcher,
│   │   │                        # candidate-merger   （search 主链 5~12）
│   │   ├── memo/                # epa-projector, residual-pyramid, tagmemo-v9,
│   │   │                        # tagmemo-v10, rivermemo, tag-expander, vector-reshaper,
│   │   │                        # geodesic-reranker
│   │   ├── postprocess/         # result-deduplicator, external-reranker, time-decay,
│   │   │                        # truncator, expander, associator
│   │   ├── output/              # result-formatter（search 结果格式化）
│   │   └── tdb/                 # query-normalizer, result-formatter（TDB 专用）
│   ├── algorithms/
│   │   ├── epa.ts               # 正交语义基 + 投影 / 共振（纯计算）
│   │   ├── residual-pyramid.ts   # 残差金字塔（纯计算，search/lookup 注入）
│   │   ├── result-deduplicator.ts# 双层去重（硬 + 语义）
│   │   ├── gram-schmidt.ts       # 正交基基元
│   │   ├── svd.ts               # 加权 PCA / 幂法 / 聚类
│   │   ├── wave-propagation.ts  # 波传播（V9 激活核）
│   │   └── topology/             # scaled-field-solver.ts（V10 双尺度场）、
│   │                            # river-observability.ts（Ω 可见性）
│   ├── providers/
│   │   ├── sqlite-metadata-store.ts  # better-sqlite3（WAL / 级联外键）
│   │   ├── vexus-vector-store.ts     # Rust N-API（VexusIndex）内存 Map + 延迟落盘
│   │   ├── openai-embedding-provider.ts # OpenAI 兼容 /v1/embeddings
│   │   └── dashscope-embedding-provider.ts # DashScope 原生 text-embedding 协议
│   ├── interfaces/              # embedding-provider / vector-store / metadata-store
│   ├── adapters/                # filesystem ingestion adapter（文件系统边界）
│   ├── reconciliation.ts        # SQLite 权威状态 → 派生向量索引重建
│   ├── tdb/
│   │   ├── tdb-engine.ts         # TDBEngine（冷知识库引擎，upsert/search 拉取式）
│   │   ├── tdb-search-pipeline.ts# TDB 查询链
│   │   ├── tdb-store.ts          # TDB 元数据（library×path 维度表）
│   │   └── triviumdb-adapter.ts  # 原生调用面本地代理（insert/search/searchHybrid/…）
│   ├── compat/knowledge-base-adapter.ts # K 调用面 Passthrough
│   └── utils/                   # text-chunker（tiktoken）、text-preprocessor、
│                               # vector-codec
├── rust-vexus-lite/              # Rust N-API 向量引擎（平台产物见 NATIVE-MATRIX.md）
├── examples/demo/                # 离线 TypeScript 源演示（编译到 dist-test/）
├── examples/real-embed/          # 真实嵌入 TypeScript 源演示
└── tests/                       # TypeScript 测试源码和 fixtures
```

## 6. 生命周期关键时序

| 时机             | 动作                            | 说明                                                                                |
| ---------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| 构造             | 三个管道 + 全部 stage 注册      | 只保存配置/注入项，不创建默认 backend 或 native addon                               |
| initialize       | Provider lazy-create + recovery | clean generation 验证并注册 persisted indexes；dirty/stale 先 reset 再 bulk rebuild |
| 摄入             | `flushBatch` 串行执行           | 双写盘：SQLite 先行 → Rust 向量索引；`scheduleIndexSave` 延迟落盘（延迟见 config）  |
| 检索（每次查询） | `search()`                      | 按配置门组合阶段；去重阶段仍在链中                                                  |
| 删除             | `handleDelete`                  | FK 级联删块，向量 Remove + 触发延迟落盘                                             |
| 关闭             | `close()`                       | queue drain → flush → mark clean → SQLite close；失败抛 lifecycle 并可重试          |

验证视角:`tests/engine/test-engine.test.ts`（生命周期）、`tests/pipelines/test-pipelines.test.ts`（布局）、`tests/stages/*`（各阶段独立行为）。
