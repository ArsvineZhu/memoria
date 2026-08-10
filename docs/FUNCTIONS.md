# FUNCTIONS — 完整功能说明

> 按功能域逐一说明 memoria 的完整能力：引擎核心、六类阶段族、混合检索、
> 语义去重、EPA、标签体系、删除级联、TDB 冷知识库与统计。所有阶段类名 /
> 阈值 / 默认值均取自源码；每节附"验证视角"指向对应 `tests/` 目录。

## 1. 引擎核心

**工厂与类**：`createMemoryEngine(options)` → `MemoryEngine`（见
[ARCHITECTURE.md](./ARCHITECTURE.md) §2）。`mergeConfig` 语义（
`src/config/default-config.ts`）：`null/undefined` 输入返回 DEFAULT_CONFIG
副本；简单对象字段一层深合并（如 `sourcePriority`）；数组与标量整体替换；
显式 `undefined` 保持默认。

**生命周期方法表**：

| 方法                      | 参数                                                                        | 返回                                 | 语义                                                |
| ------------------------- | --------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------- |
| `initialize()`            | —                                                                           | `Promise<void>`                      | 幂等；加载 rag 参数 + 热调参 + onReady              |
| `flushBatch(files)`       | `Array<{path, relPath?, content?, mtime?, size?}>` 或单对象或路径字符串数组 | 逐文件信封数组                       | 摄入；`content`/`mtime`/`size` 预置可跳过文件系统读 |
| `flush(files)`            | 同上                                                                        | 同上                                 | flushBatch 别名                                     |
| `search(query, options?)` | string 或 `{query, options}`                                                | 完整结果信封                         | 混合检索                                            |
| `handleDelete(input)`     | `{path}` 或字符串                                                           | `{deleted, fileId, removedChunkIds}` | 删除单文件                                          |
| `deleteFile(filePath)`    | string                                                                      | 同上                                 | handleDelete 别名                                   |
| `getStats()`              | —                                                                           | 统计信封（见 §9）                    | 会话统计                                            |
| `close()`                 | —                                                                           | `Promise<void>`                      | 落盘 + 关闭，幂等                                   |

摄入信封字段：`fileId, chunkIds, tagIds, removedChunkIds, vectorIndexWritten,
skipped`（未变更文件为 `skipped:true`，不重嵌入）。

验证视角：`tests/engine/test-engine.test.ts`、`tests/pipelines/test-pipelines.test.ts`。

## 2. 六类阶段族（真实 stage 类名）

### 2.1 Ingestion（摄入：文本读取与分块，8 阶段固定链）

`IngestPipeline` 串行执行：

| 顺序 | Stage 类名                 | 文件                              | 行为要点                                                                                                                                                                                               |
| ---- | -------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | `FileReaderStage`          | `stages/ingestion/file-reader.ts` | 读取 adapter 提供的稳定快照（或读盘）；逻辑内容 md5；相对路径 `/` 归一化；目录首段为 diaryName；正文未变时 `needsChunkEmbedding:false`（`needsEmbedding` 为兼容别名）；读前后快照守卫（unstable 标记） |
| 2    | `TagExtractorStage`        | `tag-extractor.ts`                | 合并 `.mdx` front matter tags 与文末连续 `Tag:` 行；黑名单 / 超集黑名单 / 长度与日期过滤 / maxTagsPerFile；与已有文件标签比较并识别 tag-only 变化                                                      |
| 3    | `ChunkerStage`             | `text-chunker.ts`                 | 按句子切块（`split(/(?<=[。？！.!?\n])/)`），tiktoken 计数，超长句强制切分，相邻块按 overlapTokens 重叠                                                                                                |
| 4    | `ChunkEmbedderStage`       | `chunk-embedder.ts`               | 块批量嵌入；失败（null）项剔除，块序保持                                                                                                                                                               |
| 5    | `TagEmbedderStage`         | `tag-embedder.ts`                 | 标签批量嵌入                                                                                                                                                                                           |
| 6    | `MetadataWriterStage`      | `metadata-writer.ts`              | SQLite 写入：正常路径原子替换 file/chunks/tags/file_tags；仅标签变化时要求 `replaceDocumentTags` 原子更新并保留 chunks；旧块 id 输出为 `removedChunkIds`；可选 kv_store 检查点                         |
| 7    | `VectorIndexerStage`       | `vector-indexer.ts`               | 向量写入：日记索引（名 = diaryName）+ `global_tags` 标签索引；先删遗留后 upsert（幂等重嵌）；触发延迟落盘                                                                                              |
| 8    | `CooccurrenceBuilderStage` | `co-occurrence-builder.ts`        | 默认有意跳过（不重建派生图）；`cooccurrenceRebuild` 开启时重建共现矩阵，TagMemo 也可由调用方将 `buildCooccurrenceMatrix()` 结果注入 `ctx.tagGraph`                                                     |

分块参数：`chunkMaxTokens`（默认 600，别名 `maxTokens`）、`chunkOverlapTokens`
（默认 96，别名 `overlapTokens`）；超长单句由 `forceSplitLongText` 硬切。

验证视角：`tests/stages/test-ingestion-stages.test.ts`（读/提取/分块/嵌入）
与 `test-ingestion-write-stages.test.ts`（写侧 3 阶段）。

### 2.2 Embedding（嵌入）

接口 `EmbeddingProvider`（`src/interfaces/embedding-provider.ts`）；引擎默认装配
`OpenAIEmbeddingProvider`；可选 `DashScopeEmbeddingProvider` 与离线
`FakeEmbeddingProvider`。查询侧嵌入由 `QueryEmbedderStage` 以
`{textType:'query'}` 调起（DashScope 非对称检索规格）。详见
[EMBEDDING.md](./EMBEDDING.md)。

### 2.3 Candidate（混合召回：向量 + 稀疏双路）

| Stage 类名             | 文件                                   | 职责                                                                                                                                                            |
| ---------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QueryEmbedderStage`   | `stages/retrieval/query-embedder.ts`   | 查询嵌入 + 可选变体（`queryExpansion>1` 且注入 `rephraserFn`）+ epsilon 掩码；输出 `queries: [{text, vector}]`                                                  |
| `VectorSearcherStage`  | `stages/retrieval/vector-searcher.ts`  | 使用统一 scope resolver；调用参数 aliases > 配置默认值 > authority discovery > `Root` fallback；空 scope 返回空结果；逐查询逐索引 KNN并过滤标签扩展             |
| `BM25SearcherStage`    | `stages/retrieval/bm25-searcher.ts`    | 按 resolver 给出的 scope 执行 BM25（k1=1.5，b=0.75）；空 scope 返回空结果；默认分词 = 英文词 + CJK 二元组/单字；IDF 标准公式；仅保留正分项，按 `bm25PoolK` 截断 |
| `CandidateMergerStage` | `stages/retrieval/candidate-merger.ts` | 双路归一化 + 加权和融合；`minScore` 过滤；可选时效衰减；按 `topK` 截断                                                                                          |

验证视角：`tests/stages/test-retrieval-stages.test.ts`。

scope 由一个 resolver 统一解析，优先级为调用参数 aliases > 配置默认值 > authority
discovery > `Root` fallback。`resolvedIndexNames: []` 是明确空 scope，vector、BM25、
标签扩展和 association candidates 都返回空范围；`undefined` 才表示尚未解析或旧调用
兼容。搜索 envelope 中的 `scopeSource` 与 `scopeWasExplicit` 可用于诊断，完整字段说明
见 [检索能力矩阵](RETRIEVAL_FEATURES.md)。

### 2.4 Retrieval（检索主链编排）

`SearchPipeline` 固定前段（queryEmbedder → queryVectorBridge → 双路召回 →
融合）后按配置门插入 memo / 后处理算子，末段必为 `resultFormatter`。完整阶段顺序
与开关见 [ARCHITECTURE.md](./ARCHITECTURE.md) §4。

### 2.5 Postprocessing（后处理：EPA / 去重 / 格式化）

| Stage 类名                | 文件                                        | 职责                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EPAProjectorStage`       | `stages/memo/epa-projector.ts`              | 查询 EPA 投影：`{ready, queryAnalysis: {logicDepth, dominantAxes, resonance}, candidateAnalyses}`                                                                                                                                                    |
| `ResidualPyramidStage`    | `stages/memo/residual-pyramid.ts`           | 残差金字塔：`{levels, totalExplainedEnergy, finalResidual, features}`                                                                                                                                                                                |
| `ResultDeduplicatorStage` | `stages/postprocess/result-deduplicator.ts` | 硬去重 + 语义去重（阈值 0.92）                                                                                                                                                                                                                       |
| `ExternalRerankerStage`   | `external-reranker.ts`                      | 调用配置中的 `reranker` 或上下文中的 `ctx.reranker(query, candidates)` 重排（门：`externalRerankEnabled` / `useLLMRerank`）                                                                                                                          |
| `TimeDecayStage`          | `time-decay.ts`                             | `decay = 0.5^(ageDays/halfLife)`；`timeDecayUpperBound` 封顶                                                                                                                                                                                         |
| `TruncatorStage`          | `truncator.ts`                              | 按 `topK` 或 `maxResults` 截断条数，再按 `maxContentLength` 截断内容，可选添加省略号                                                                                                                                                                 |
| `ExpanderStage`           | `expander.ts`                               | 前 `expandCount` 个候选展开同文件兄弟块，分数 ×`expansionBoost`                                                                                                                                                                                      |
| `ResultFormatterStage`    | `stages/output/result-formatter.ts`         | 终格式化：`{id, chunkId, content, path, sourceFile, fileId, diaryName, score, similarity, updatedAt, mtime, tags, matchedTags, memoScore?, source, decay?, associationChannel?, associationOf?, rerankScore?}` + `resultCount`；缺失字段从元数据回查 |

另有 TagMemo 家族 5 个算子（`TagMemoV9Stage` / `TagMemoV10Stage` /
`RiverMemoStage` / `TagExpanderStage` / `VectorReshaperStage`），普通库配置门
默认关闭；真实召回 Demo 会显式开启它们，并在结果 envelope 中输出实际 trace。完整
依赖和跳过条件见 [检索能力矩阵](RETRIEVAL_FEATURES.md)。

验证视角：`tests/stages/test-memo-stages.test.ts`、`test-tagmemo-stages.test.ts`、
`test-postprocess-stages.test.ts`。

### 2.6 Storage（存储：SQLite 元数据 + Rust 向量）

| 组件                                 | 文件                                 | 要点                                                                                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SqliteMetadataStore`                | `providers/sqlite-metadata-store.ts` | better-sqlite3；WAL / NORMAL / 外键开；表：`files` / `chunks`（FK 级联）/ `tags` / `file_tags` / `kv_store`；接口方法全 async                                                                                                                            |
| `VexusVectorStore`                   | `providers/vexus-vector-store.ts`    | Rust N-API `VexusIndex`（usearch）；内存 Map 管理命名索引；clean restore 验证后注册磁盘索引，dirty/stale 时严格 reconciliation；延迟保存（`indexSaveDelay` / `tagIndexSaveDelay`）；`persistTagIndex=false` 忽略旧 `global_tags` 文件并从 authority 重建 |
| `VectorStore` / `MetadataStore` 接口 | `interfaces/`                        | 抽象契约：`add/addBatch/search/remove/loadIndex/saveIndex/getIndexStats`；恢复要求 `rebuildDerivedState(plan)`，或同时提供 `resetDerivedState + replaceIndex`；SQLite 标签-only 更新使用可选 `replaceDocumentTags`                                       |

验证视角：`tests/providers/test-sqlite-metadata-store.test.ts`、
`test-vexus-vector-store.test.ts`。

## 3. 混合检索（向量 + BM25 融合权重）

- **向量路**：`VectorSearcherStage` → Rust VexusIndex **精确余弦** KNN。
  索引名 = 日记（相对路径首段），标签索引 `global_tags`。
- **词路**：`BM25SearcherStage` 在统一 scope 内遍历块语料
  （`metadataStore.getAllChunks()`），BM25 标准公式 + 中文二元组分词。
- **融合**（`candidateMerger`）：各源分数按源最大值归一化到 [0,1] → 加权和
  `vectorWeight × V + bm25Weight × B`（引擎默认 **0.7 / 0.3**；别名
  `hybridAlpha`/`hybridBeta` 同值；stage 兜底 0.6/0.4）→ 按 chunkId 去重取高
  → `minScore` 过滤 → `topK` 截断。
- **结果两种字段格式**（键名差异注意）：
  - 主检索管线（`result-formatter.ts`）：**`content`**（块文本）、
    **`path`**（相对路径）、`sourceFile`（basename）、`score`/`similarity`、
    `tags`/`matchedTags`、`memoScore`、`decay`、`associationChannel`、
    `associationOf`、`rerankScore`。
  - 兼容层 legacy 向量路径（`KnowledgeBaseAdapter.search(diary, vec, k)`）：
    **`text`**、**`fullPath`**、`matchedTags`、`tagMatchCount`、
    `coreTagsMatched`、`boostFactor`、`tagMatchScore`。
    格式化阶段对输入同时接受 `candidate.text` 与 `candidate.content`。

验证视角：`tests/engine/test-engine.test.ts`（端到端混合检索）、
`tests/stages/test-retrieval-stages.test.ts`（融合单测）。

## 4. 语义去重（ResultDeduplicator）

算法文件 `src/algorithms/result-deduplicator.ts`，双层：

1. **硬去重**（无条件，始终）：三种精确身份——`chunkId`、规范化正文
   （NFKC + 空白/换行规整 + 小写）、`path:chunkIndex`；无稳定身份的候选不合并。
   同一身份多个版本选代表：**来源优先级 > 分数 > 信息完整度**
   （`sourcePriority` 默认 `{rag:50, time:45, bm25_body:40, bm25_tag:40,
continuity:35, associate:10, unknown:0}`）。
2. **语义去重**（可选，默认开）：候选数 ≥ `minSemanticCandidates`（默认 **2**）
   后执行——按与查询向量的余弦相似度排序，逐项与已选集合比较余弦，
   超过 **`semanticThreshold`（默认 0.92）** 判为近重复舍弃；无向量 / 长度
   不符的候选安全保留。阈值可经 `rag_params.json →
KnowledgeBaseManager.resultDeduplication.semanticThreshold` 热调
   （engine `_applyRagParamsToConfig`）。`dedupeEnabled=false` 时阶段跳过
   （`dedupeSkipped`）。

输出：`dedupeStats: { removed, kept, duplicates: [{chunkId}] }`。

验证视角：`tests/algorithms/`（去重器单测）、`tests/stages/test-postprocess-stages.test.ts`。

## 5. EPA 三个量（src/algorithms/epa.ts）

`EPA` 从标签向量构建正交语义基（`EPA.computeBasis` → `clusterTags` →
`computeWeightedPCA` → `selectBasisDimension`），对查询 `project()` 输出：

| 量                       | 含义                                                   | 计算                                                                                                 |
| ------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `logicDepth`（逻辑深度） | 查询在语义空间的"专注度"（越高越聚焦少数主轴）         | `1 − normalizedEntropy`；归一化熵 = `entropy / log2(K)`                                              |
| `dominantAxes`（主导轴） | 能量占比 > 0.05 的基轴（含 `label/energy/projection`） | 概率 = 投影² / 总能量，按能量降序                                                                    |
| `resonance`（跨域共振）  | 多轴联合激活强度                                       | `detectCrossDomainResonance`：主轴与次轴强度 `√(e₁·e₂)` > 0.15 建桥，`resonance = Σ bridge.strength` |

配置默认：`epaClusterCount=64`、`epaMaxBasisDim=64`、
`strictOrthogonalization=true`；可选 Rust `vexusIndex.project` 加速，失败回退
JS。残差金字塔另输出 `features = {depth, coverage, novelty, coherence,
tagMemoActivation, expansionSignal}`（逐层残差正交投影 + 能量解释比 + 方向相干）。

验证视角：`tests/algorithms/test-epa.test.ts`、`test-residual-pyramid.test.ts`、
`tests/engine/test-knowledge-base-adapter-rag.test.ts`（`getEPAAnalysis`）。

## 6. 标签体系

- **提取**（`utils/text-preprocessor.ts → extractTags`）：仅解析文末连续
  `Tag:` 行（遇非 Tag 行即停）；分隔符 `[,，、;|｜]`；`tagBlacklist` 完全匹配
  剔除、`tagBlacklistSuper` 并集正则删除；中文 >20 字符 / 非中文 >40 拒绝；
  日期形态拒绝；去重后截 `maxTagsPerFile`（默认 50）。预清洗
  `prepareTextForEmbedding` 剥离装饰 emoji、`<|x|>` 管道符，规整空白；
  空文本 → `[EMPTY_CONTENT]`。
- **标签向量**：`TagEmbedderStage` 嵌入后由 `VectorIndexerStage` 写入
  `global_tags` 共享索引（容量 `tagIndexCapacity`=50000）。`persistTagIndex=true`
  才会按 `tagIndexSaveDelay` 持久化并恢复；`false` 不保存该索引，恢复时从 authority
  重建内存索引但保留旧文件。
- **标签召回**：`tagSearchEnabled` 开启时，`VectorSearcherStage` 在标签索引
  取前 `tagK`（默认 10）个标签，经 `getFileIdsByTagId` → `getChunksByFileId`
  展开为候选块（打分继承标签命中分）。
- **聚类 / 结构化**：`algorithms/svd.ts`——`clusterTags`（k-means，余弦分配，
  Forgy 初始化，空质心以最远点重初始化，最多 50 轮）、`computeWeightedPCA`
  （加权 Gram 阵 + 幂法 + 收缩）、`selectBasisDimension`（95% 方差，至少 8 维）；
  供 EPA 基构建与独立调用。
- **共现图**：`buildCooccurrenceMatrix`（SQL 自联接）；TagMemo 所需的
  `ctx.tagGraph` 由调用方在内存中注入（库本身不内置监听器）；图未注入时相关 stage
  会跳过，不会伪造联想结果。

验证视角：`tests/utils/test-text-preprocessor.test.ts`、
`tests/algorithms/test-svd.test.ts`、`tests/stages/test-ingestion-stages.test.ts`。

## 7. 删除级联

`DeletePipeline → FileDeleterStage`（`stages/ingestion/file-deleter.ts`）：

1. 相对路径归一化 → `getFileByPath` 查找
2. `metadataStore.deleteFile(fileId)`——SQLite FK 级联删 `chunks` /
   `file_tags`
3. `vectorStore.remove` 逐块删除日记索引向量（幂等容错：不存在的向量静默）
4. `scheduleIndexSave` 触发延迟落盘
5. 返回 `{ deleted, fileId, removedChunkIds }`；未知路径 → `{ deleted: false }`

**标签行与 `global_tags` 不参与级联删除**（设计使然：标签跨文件共享）。

验证视角：`tests/pipelines/test-pipelines.test.ts`、`tests/engine/test-engine.test.ts`
（删除后再查询消失）。

## 8. TDB 冷知识库（`src/tdb/`）

| 模块                | 一句话职责                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TDBEngine`         | 冷知识库主引擎：拉取式摄入（`upsertText` / `upsertFile`）、按库混合索引、`search`/`searchWithVector` 检索、`getStats` 与关闭（无 watcher / 队列）                           |
| `TDBSearchPipeline` | TDB 查询链：`tdbQueryNormalizer`（问句/关键词识别）→ queryEmbed（预置 vector 则跳过）→ vectorSearcher → bm25Searcher → candidateMerger → [timeDecay] → `tdbResultFormatter` |
| `TDBStore`          | TDB 元数据：`libraries`（UNIQUE(library, path)）、`chunks`（UNIQUE(library, path, chunk_index)）、`meta`（getMeta/setMeta）、`healthCheck`                                  |
| `TriviumDBAdapter`  | 本地"原生调用面"代理（`insert/delete/search/searchHybrid/link/indexText/flush/stats`）；无远端服务；无向量存储时惰性返回空结果                                              |

使用要点：`tdbEnabled: true`（默认 false）。摄入内容用 **sha256 checksum**
去重（主链为 md5）；每库一个向量索引；嵌入分批 `tdbEmbeddingBatchSize=16`；
检索旋钮 `tdbTopK=10 / tdbMinScore=0.1 / tdbHybridAlpha=0.7 /
tdbExpandDepth=1`；查询 `options.libraries` 映射为共享阶段的
`diaryNames`。结果字段：`{library, id, score, payload, text, sourceFile,
chunkIndex}`。

验证视角：`tests/tdb/test-tdb.test.ts`。

## 9. 统计 / usage

- **会话统计**：`getStats()` 返回 `{files, chunks, tags, diaries,
lastIndexed, vectorStats, healthy, initialized}`（详见
  [GUIDE.md](./GUIDE.md) §6）。
- **Provider 用量**：`OpenAIEmbeddingProvider` / `DashScopeEmbeddingProvider`
  均**不**暴露 token / 请求计数（DashScope 响应中的 `usage` 字段仅内部解析，
  未对外导出）；引擎亦无 usage 计数器。需要用量审计时应在 Provider 外自包
  计数装饰器。

验证视角：`tests/engine/test-engine.test.ts`（getStats 字段断言）。
