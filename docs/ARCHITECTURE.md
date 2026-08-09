# ARCHITECTURE — memoria 架构总览

> 本文档描述 memoria（Node.js 产品化记忆系统）的整体架构：引擎生命周期、
> 管线编排、分层组件与存储链路。所有组件名、阶段名、默认值均以仓库源码为准。

## 1. 总体设计

memoria 的核心是一个**算子级 stage 编排管线**：三段主管线（ingest / search /
delete）由可插拔 `Stage` 串联，所有阶段共享一个 `PipelineContext`（依赖注入容器）
读配置、取 Provider。记忆侧算法（TagMemo / RiverMemo / EPA / 残差金字塔）以
"可选阶段"或"查询痕迹"的形式注入检索结果；底层由 **SQLite 元数据存储**（文件 /
块 / 标签表）与 **Rust N-API 向量索引**（VexusIndex，日记维度索引 + 共享标签索引）
双持久化支撑。

```
                    ┌────────────────────────────────────────────┐
                    │             MemoryEngine (engine.ts)        │
                    │  config │ providers │ ctx │ 3 pipelines     │
                    └───────┬────────────────────────────┬───────┘
             flushBatch ────┤                            ├── search / handleDelete
                            ▼                            ▼
              ┌────────────────────┐          ┌────────────────────┐
              │   IngestPipeline   │          │ SearchPipeline     │
              │   8 阶段固定串行    │          │ 5 检索 + 7 记忆 +   │
              │   read→tags→chunk  │          │ 5 后处理 +1 输出     │
              │   →embed→write→vec │          └────────────────────┘
              └───────┬────┬──────┘
                      ▼    ▼
          ┌────────────────────┐
          │ SqliteMetadataStore│   VexusVectorStore（Rust N-API）
          │  files/chunks/tags │   diary 索引 + global_tags 索引
          │  file_tags/kv_store│
          └────────────────────┘
```

## 2. MemoryEngine 生命周期

`createMemoryEngine(options)` 是唯一工厂入口（`src/engine.ts`；发布产物为 `dist/src/engine.js`）：

```
createMemoryEngine({config, dbPath, embeddingProvider, ...})
  │
  ├─ 1. mergeConfig(DEFAULT_CONFIG)          ← config 与默认值合并（一层深合并）
  ├─ 2. 装配 Provider：
  │      metadataStore  SqliteMetadataStore（dbPath，默认 ':memory:'）
  │      vectorStore    VexusVectorStore（dimension/storePath/延迟落盘）
  │      embeddingProvider 默认 OpenAIEmbeddingProvider；可注入替代
  ├─ 3. PipelineContext 组装（config + 三个 Provider + 可选 ctx 扩展字段）
  └─ 4. 三条管线构建（IngestPipeline / DeletePipeline / SearchPipeline）

initialize()        ── 幂等：加载 rag_params.json（可选）→ 将热调参
                       （语义去重阈值、maxResults、sourcePriority、riverMemo
                        门）应用进 config → onReady 回调 → initialized=true
flushBatch(files)   ── 逐文件串行执行 IngestPipeline；返回每文件结果信封
flush(files)        ── flushBatch 别名（兼容 KBM 调用形状）
search(query)       ── 混合检索；query 可为字符串或 {query, options}
handleDelete()      ── 删除单文件（行 + 块级联 + 日记索引向量清除）
deleteFile()        ── handleDelete 的便捷别名
getStats()          ── { files, chunks, tags, diaries, lastIndexed,
                        vectorStats, healthy, initialized }
close()             ── 幂等：先 flushPendingSaves()（向量落盘），再关闭 SQLite
```

### 初始化时序细节

1. **构造期（同步）**：配置合并 → Provider 装配 → ctx → **管线与全部默认阶段在此
   注册**（`IngestPipeline.defaultStages` / `SearchPipeline.defaultStages` /
   `DeletePipeline.defaultStages`）。引擎此时未就绪（`initialized=false`），
   未打开数据库。
2. **initialize()（异步，幂等）**：并发调用共享同一次执行（`_initPromise`）：
   读 rag_params.json → `_applyRagParamsToConfig`（去重阈值/结果上限/最少语义
   候选/sourcePriority 注入）→ `onReady` → 置 `initialized=true`。
3. **flushBatch 时序（单文件）**：`FileReaderStage` 先做变更检测（md5 + mtime +
   size 全匹配则 `needsEmbedding=false` 跳过），随后 7 个阶段依次执行，最后
   `CooccurrenceBuilderStage`（默认 no-op）。**双写盘次序**：`MetadataWriterStage`
   先落 SQLite（files / chunks / tags / file_tags / 可选 kv_store 检查点），
   `VectorIndexerStage` 后写向量（先删遗留向量再 upsert，日记索引 + global_tags
   标签索引），并触发 `scheduleIndexSave`（延迟落盘）。
4. **shutdown**：`close()` → `vectorStore.flushPendingSaves()`（幂等）→
   `metadataStore.close()`，懒加载索引在首次访问时才从磁盘恢复。

## 3. 组件分层

| 层 | 目录 | 职责 | 关键成员 |
|----|------|------|----------|
| Core | `src/core/` | 管线编排内核 | `Pipeline`（串行执行 / pipe / replace）、`Stage`（抽象 process）、`PipelineContext`（DI 容器） |
| 配置 | `src/config/` | 全量默认参数 + 加载 | `DEFAULT_CONFIG`、`mergeConfig`、`loadRagParams` / `loadRagParamsSync` / `RAG_PARAMS_DEFAULTS` |
| Compat | `src/compat/` | 老调用面兼容 | `KnowledgeBaseAdapter`（KBM drop-in 封装；`db` / `config` / 派发式 `search` / `runExternalFileMutation` 等） |
| Stages | `src/stages/` | 算子群（6 子目录） | ingestion ×8、retrieval ×4、memo ×7、postprocess ×5、output ×1、tdb ×2 |
| Pipelines | `src/pipelines/` | 阶段组合 | `IngestPipeline` / `SearchPipeline` / `DeletePipeline` |
| Providers | `src/providers/` | 存储与嵌入实现 | `SqliteMetadataStore`、`VexusVectorStore`、`OpenAIEmbeddingProvider`、`DashScopeEmbeddingProvider` |
| Interfaces | `src/interfaces/` | 三方契约（抽象类） | `EmbeddingProvider` / `VectorStore` / `MetadataStore` |
| Algorithms | `src/algorithms/` | 纯数学算法（零 I/O） | EPA、ResidualPyramid、ResultDeduplicator + gram-schmidt / svd / wave + topology/ |
| TDB | `src/tdb/` | 冷知识库引擎 | `TDBEngine` / `TDBSearchPipeline` / `TDBStore` / `TriviumDBAdapter` |
| Utils | `src/utils/` | 通用工具 | `text-chunker`（tiktoken 智能分块）、`text-preprocessor`（清洗 + 标签提取）、`vector-codec`（BLOB 编解码） |

## 4. 检索主链路（SearchPipeline，真实阶段名）

```
search(query, options)
  │
  ├─[1] queryEmbedder        查询嵌入（含查询扩展 queryExpansion、epsilon 掩码）
  ├─[2] queryVectorBridge    发布主查询向量（内部阶段，无同名文件）
  ├─[3] vectorSearcher       向量召回（日记索引逐源 KNN，按 topK 合并）
  ├─[4] bm25Searcher         BM25 稀疏召回（全库，按 bm25PoolK 截断）
  ├─[5] candidateMerger      融合：双路归一化到 [0,1] → 加权和（vectorWeight +
  │                            bm25Weight）→ 去重 → minScore → topK 截断
  │
  ├─[6] epaProjector         ● EPA 语义深度信号（投影 / 主轴 / 共振）
  ├─[7] residualPyramid      ● 残差金字塔分解（覆盖度 / 新颖度）
  ├─[8] tagMemoV9            标签波传播（浪潮激活）           [配置门]
  ├─[9] tagMemoV10           双尺度场扩散（V10）              [配置门]
  ├─[10] riverMemo            河流状态累计 + 机态重排            [配置门]
  ├─[11] tagExpander         标签驱动候选扩展                  [配置门]
  ├─[12] vectorReshaper      余弦向量重排                      [配置门]
  │
  ├─[13] resultDeduplicator  ● 硬去重 + 语义去重（阈值 0.92）
  ├─[14] externalReranker    LLM/外部排序器                    [配置门]
  ├─[15] timeDecay           时效衰减 0.5^(age/半衰期)          [配置门]
  ├─[16] truncator           topK / 内容长度截断               [配置门]
  ├─[17] expander            同文件关联块扩展                  [配置门]
  │
  └─[18] resultFormatter     结果信封（格式化 + 元数据补全）→ results/resultCount
```

- ● = 默认开启（`epaProjectionEnabled=true`、`residualPyramidEnabled=true`、
  `dedupeEnabled=true`）；其余以对应 `*Enabled` 门为假值关闭。
- 即使 `dedupeEnabled=false`，去重阶段仍在链中（内部自行决定跳过）；`resultFormatter`
  恒为末阶段。

## 5. 目录树对照

实际仓库结构（`Get-ChildItem -Recurse` 核对）与架构映射：

```text
memoria/
├── index.ts                     # TypeScript 源入口（保持 CommonJS 导出面）
├── dist/index.js                # 编译后的库入口（Core/Engine/适配器/TDB/算法/工具 共 10 组）
├── src/
│   ├── core/                    # pipeline.ts / stage.ts / context.ts
│   ├── engine.ts                # MemoryEngine 生命周期 + createMemoryEngine 工厂
│   ├── config/
│   │   ├── default-config.ts    # DEFAULT_CONFIG（全量默认参数）+ mergeConfig
│   │   └── rag-params-loader.ts # rag_params.json 热调参加载
│   ├── pipelines/
│   │   ├── ingest-pipeline.ts   # 8 阶段固定链
│   │   ├── search-pipeline.ts   # 18 步混合检索链
│   │   └── delete-pipeline.ts   # 单阶段（file-deleter）
│   ├── stages/
│   │   ├── ingestion/           # file-reader, tag-extractor, text-chunker,
│   │   │                        # chunk-embedder, tag-embedder, metadata-writer,
│   │   │                        # vector-indexer, co-occurrence-builder, file-deleter
│   │   ├── retrieval/           # query-embedder, vector-searcher, bm25-searcher,
│   │   │                        # candidate-merger   （search 主链 5~12）
│   │   ├── memo/                # epa-projector, residual-pyramid, tagmemo-v9,
│   │   │                        # tagmemo-v10, rivermemo, tag-expander, vector-reshaper
│   │   ├── postprocess/         # result-deduplicator, external-reranker, time-decay,
│   │   │                        # truncator, expander
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
│   ├── tdb/
│   │   ├── tdb-engine.ts         # TDBEngine（冷知识库引擎，upsert/search 拉取式）
│   │   ├── tdb-search-pipeline.ts# TDB 查询链（7 阶段）
│   │   ├── tdb-store.ts          # TDB 元数据（library×path 维度表）
│   │   └── triviumdb-adapter.ts  # 原生调用面本地代理（insert/search/searchHybrid/…）
│   ├── compat/knowledge-base-adapter.ts # K 调用面 Passthrough
│   └── utils/                   # text-chunker（tiktoken）、text-preprocessor、
│                               # vector-codec
├── rust-vexus-lite/              # Rust N-API 向量引擎（6 平台预编译二进制）
├── examples/demo/                # 离线 TypeScript 源演示（编译到 dist-test/）
├── examples/real-embed/          # 真实嵌入 TypeScript 源演示
└── tests/                       # 319 项编译后测试（10 目录）
```

## 6. 生命周期关键时序

| 时机 | 动作 | 说明 |
|------|------|------|
| 构造 | 三个管道 + 全部 stage 注册 | `defaultStages()` 在构造时求值（门函数已评估） |
| 首次访问 | 向量索引懒加载 | `getOrCreateIndex` 若磁盘存在持久化索引则 `VexusIndex.load`，否则新建 |
| 摄入 | `flushBatch` 串行执行 | 双写盘：SQLite 先行 → Rust 向量索引；`scheduleIndexSave` 延迟落盘（延迟见 config） |
| 检索（每次查询） | `search()` | 18 阶段（按门裁剪）；去重阶段恒在链中 |
| 删除 | `handleDelete` | FK 级联删块，向量 Remove + 触发延迟落盘 |
| 关闭 | `close()` | `flushPendingSaves()`（失败仅记日志，不阻断）+ 关闭 SQLite；幂等 |

验证视角:`tests/engine/test-engine.test.ts`（生命周期）、`tests/pipelines/test-pipelines.test.ts`（布局）、`tests/stages/*`（各阶段独立行为）。
