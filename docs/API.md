# API — 导出符号参考

> 权威事实源：`package.json` 的 `exports`、`src/index.ts`、`src/index.cts`、
> `src/errors.ts` 和公开类型。库是 ESM-first；历史 CommonJS consumer 通过
> `dist/index.cjs` 兼容 facade 保留。`dist/` 是生成的打包验证输出，不是新的 API
> 声明来源。
>
> ```ts
> const esm = await import("memoria");
> Object.keys(esm); // Node ESM namespace 的排序结果
> ```
>
> ```ts
> import { createRequire } from "node:module";
> const require = createRequire(import.meta.url);
> Object.keys(require("memoria")); // 当前 CommonJS 运行时导出
> ```
>
> 分组名与 `index.ts` 顶部注释一致；每个符号给出签名、参数、返回值和默认值。
> 类型标注以 TypeScript 源码和 `dist/index.d.ts` 为准。

## 0. 全量导出清单

<!-- runtime-exports:start -->

```text
Pipeline
Stage
PipelineContext
createMemoryEngine
MemoryEngine
DEFAULT_CONFIG
mergeConfig
loadRagParams
loadRagParamsSync
RAG_PARAMS_DEFAULTS
KnowledgeBaseAdapter
TDBEngine
TDBSearchPipeline
TDBStore
TriviumDBAdapter
resolveLibrary
safeLibraryName
EPA
ResidualPyramid
ResultDeduplicator
dotProduct
magnitude
normalize
orthogonalize
orthogonalProjection
clusterTags
computeWeightedPCA
powerIteration
selectBasisDimension
buildRowOperator
solveDualScaledFields
normalizeSource
effectiveSupport
propagate
computeFirWeights
adjacencyFromEdges
computeRiverObservability
decodeVectorBlob
encodeVectorBlob
prepareTextForEmbedding
extractTags
```

<!-- runtime-exports:end -->

上表必须与当前 `src/index.ts` 的运行时导出保持一致；`corepack pnpm verify:docs`
会检查这两个清单是否发生漂移。如需核对构建产物，可重新运行上方的
`Object.keys` 示例。下列分组按 `src/index.ts` 注释划分。

## 0.1 检索相关公共类型

除上面的运行时导出外，根入口还提供以下类型导出。它们不会出现在
`Object.keys(import("memoria"))` 中，但会出现在 `dist/index.d.ts`，可用于声明检索
增强 hook、查询向量和结果诊断：

```text
ExternalReranker
QueryRephraser
Tokenizer
QueryVector
EpaEnvelope
EpaQueryAnalysis
EpaDominantAxis
PyramidData
PyramidFeatures
PyramidLevel
PyramidTag
TagMemoData
TagExpansionData
VectorReshapeData
RiverMemoData
DedupeStats
TruncationStats
ExpansionStats
```

完整的开关、依赖、跳过条件和 Demo 入口由
[检索能力矩阵](RETRIEVAL_FEATURES.md) 维护。

## 1. Core

| 符号              | 签名                                                                                                                                              | 说明                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Pipeline`        | `Pipeline<Input, Output>`；`new Pipeline(stages = [])`；`run(initialInput, ctx) → Promise<Output>`；`pipe(stage)`；`replace(stageName, newStage)` | 阶段串行编排器。每个 stage 的输出作为下一个的输入                                                                                       |
| `Stage`           | `Stage<Input, Output>`；子类实现 `async process(input, ctx)`                                                                                      | 所有阶段基类；未实现 `process` 抛错                                                                                                     |
| `PipelineContext` | `new PipelineContext({config, embeddingProvider, vectorStore, metadataStore, vexusIndex?, epa?, riverStateStore?, tagGraph?, reranker?})`         | 跨阶段共享的 DI 容器；`vexusIndex` 为 Rust N-API 句柄、`epa` 预构建 EPA 基、`tagGraph` 标签共现图，`reranker` 为可选 `ExternalReranker` |

## 2. 引擎工厂 + 配置加载

| 符号                                                | 签名                                                                                                                                                                                         | 说明                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `createMemoryEngine(options?)`                      | `options: {config?, dbPath?, ragParamsPath?, ragParams?, embeddingProvider?, vectorStore?, metadataStore?, ctx?, ingestOptions?, deleteOptions?, searchOptions?, onReady?}` → `MemoryEngine` | 工厂：构建（不打开）引擎                                        |
| `MemoryEngine`                                      | `new MemoryEngine(options)`                                                                                                                                                                  | 引擎类，生命周期方法见下                                        |
| `DEFAULT_CONFIG`                                    | 对象                                                                                                                                                                                         | 全量默认配置（字段表见 [CONFIGURATION.md](./CONFIGURATION.md)） |
| `mergeConfig(userConfig)`                           | `(object\|null\|undefined) → object`                                                                                                                                                         | 默认合并：一层深合并对象、整替换数组/标量、`undefined` 不覆盖   |
| `loadRagParams({path?, overrides?, defaults?})`     | `→ Promise<object>`                                                                                                                                                                          | 从 rag_params.json 异步加载（缺失文件 → `{}`；根必须为对象）    |
| `loadRagParamsSync({path?, overrides?, defaults?})` | `→ object`                                                                                                                                                                                   | 同步变体；文件不存在则跳过                                      |
| `RAG_PARAMS_DEFAULTS`                               | `{}`                                                                                                                                                                                         | 默认装载基                                                      |
| `KnowledgeBaseAdapter`                              | `new KnowledgeBaseAdapter({engine})` （engine 必填，否则 TypeError）                                                                                                                         | KBM 兼容层；方法面见下方清单和 [FUNCTIONS.md](FUNCTIONS.md) §1  |

**MemoryEngine 实例方法**（类型与实现摘自 `src/engine.ts`）：

- `initialize()` — Promise<void>；幂等、并发共享
- `ingest(document)` / `upsert(document)` — Promise<`MemoryDocumentIngestResult>`；无路径逻辑文档，按 `id + revision` 幂等更新
- `ingestBatch(documents)` — Promise<`MemoryDocumentIngestResult[]`>；顺序执行并保留输入顺序
- `remove(documentId)` — Promise<`MemoryDocumentDeleteResult>`；按稳定逻辑身份删除，未知身份幂等
- `flushBatch(files)` | `flush(files)` — Promise<Array<object>>（每文件信封）
- `search(query, options?)` — Promise<object>（`{ ..., results, resultCount }`）
- `handleDelete(input)` | `deleteFile(filePath)` — Promise<object>（`{ deleted, fileId, removedChunkIds }`）
- `getStats()` — Promise<{files, chunks, tags, diaries, lastIndexed, vectorStats, healthy, initialized}>
- `close()` — Promise<void>；幂等

`MemoryDocumentInput` 至少包含 `{ id: string, content: string }`，可选 `revision`、
`source` 与 JSON-safe `metadata`。文件系统入口位于 `memoria/adapters/filesystem`，
错误类型位于 `memoria/errors`；文件适配器位于 `memoria/adapters/filesystem`，两者都不增加根入口运行时导出。

**子路径导出**：

| 子路径                        | 主要导出                         | 模块边界                    |
| ----------------------------- | -------------------------------- | --------------------------- |
| `memoria/adapters/filesystem` | `FilesystemIngestionAdapter`     | 文件扫描、读取和监听        |
| `memoria/errors`              | `MemoriaError`、`asMemoriaError` | 结构化错误类型和转换函数    |
| `memoria/providers/openai`    | `OpenAIEmbeddingProvider`        | OpenAI 兼容嵌入 Provider    |
| `memoria/providers/dashscope` | `DashScopeEmbeddingProvider`     | DashScope 原生嵌入 Provider |

这些子路径当前提供 ESM 入口和类型声明；CommonJS 兼容仅由根包入口提供。

### `memoria/errors` 契约

`memoria/errors` 导出 `MemoriaError`、`asMemoriaError`，以及类型
`MemoriaErrorCode` 和 `MemoriaErrorOptions`。稳定错误码为：
`configuration`、`ingestion`、`persistence`、`embedding`、`vector_backend`、
`integrity`、`retrieval`、`lifecycle`、`concurrency`。`concurrency` 用于报告
稳定读阶段中的写入重入等会导致等待环的调用。

`MemoriaError` 的公共字段是 `code`、`retryable` 和只读 `details`；构造参数为
`(code, message, {cause?, retryable?, details?})`。`asMemoriaError(error, code,
message, options?)` 会为未知错误保留原始 `cause`，已有 `MemoriaError` 则原样返回。

`search()` 的 scope precedence 是：调用参数 aliases
（`indexNames` / `diaryNames` / `diaryName` / `libraries`）→ 配置默认值 → SQLite
authority discovery → `Root` compatibility fallback。显式空数组表示空 scope，不会
回退；vector、BM25、标签扩展与结果 hydration 共享同一 scope。`timeDecay` 只由
`TimeDecayStage` 执行。搜索结果 envelope 还会保留 `vectorResults`、`bm25Results`、
`tagExpansion`、`vectorReshape`、`tagMemo`、`riverMemo`、`geodesic`、`epa`、
`pyramid`、`associatorStats`、`dedupeStats`、`truncationStats`、`expansionStats` 以及
`reranked`/`rerankSkipped`/`rerankError` 等诊断字段；字段可能因开关或依赖未满足而
缺省。详见 [检索能力矩阵](RETRIEVAL_FEATURES.md)。

**KnowledgeBaseAdapter 方法面**：`initialize / shutdown / flush / flushBatch /
handleDelete / deleteFile / getStats / close / removeDocument / search /
getMemoryProfile / getHealthStatus / runExternalFileMutation /
deduplicateResults / getEPAAnalysis / applyTagBoostAsync /
rerankWithTagMemoAsync / rerankWithRiverMemoAsync / getDiaryDateIndex /
getDiaryNameVector / getVectorByText / getVectorByChunkId /
getChunksByFilePaths`，另有只读 `initialized` / `db` / `config` 属性
（legacy search 的向量路径返回 `{chunkId, text, score, sourceFile, fullPath,
matchedTags, tagMatchCount, coreTagsMatched, boostFactor, tagMatchScore}`）。

## 3. TDB 冷知识库

| 符号                | 签名                                                                                                   | 说明                                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TDBEngine`         | `new TDBEngine({config?, metadataStore?, vectorStore?, embeddingProvider?, trivium?, searchOptions?})` | 冷知识库引擎。方法：`initialize() → Promise<boolean>`、`upsertText(text, options?)`、`upsertFile(filePath, options?)`、`removeFile(input)`、`removeText(options)`、`search(queryText, options?)`、`searchWithVector(vec, queryText, options?)`、`listLibraries()`、`getStats()`、`close()` |
| `TDBSearchPipeline` | `new TDBSearchPipeline(config, options?)`；`run({query, vector?, options?}, ctx)`                      | TDB 查询链（`tdbQueryNormalizer` → queryEmbed → `searchScopeResolver` → 双路召回 → 融合 → [timeDecay] → `tdbResultFormatter`）；`tdbEnabled=false` 返回 `{tdbDisabled:true, results:[], resultCount:0}`                                                                                    |
| `TDBStore`          | `new TDBStore({dbPath, busyTimeout?, busyRetryDelay?})`                                                | TDB 元数据与 vector authority：`replaceDocumentState/deleteDocumentState/getTdbRebuildChunks/updateChunkVectors/getTdbGenerationState/markTdbVectorStateClean` 以及传统文件、分块、library、meta、health、close 方法                                                                       |
| `TriviumDBAdapter`  | `new TriviumDBAdapter({vectorStore?, metadataStore?, indexName?, dimension?, idSeq?})`                 | 本地原生调用面代理：`insert(vector, payload?, options?)/submit/delete/search/searchHybrid/link/indexText/buildTextIndex/flush/stats`；无服务端                                                                                                                                             |
| `resolveLibrary`    | `(rootPath: string, absPath: string) → {library: string, relPath: string}`                             | 根相对路径首段 = library，否则 `'Root'`                                                                                                                                                                                                                                                    |
| `safeLibraryName`   | `(name: string) → string`                                                                              | 非法文件名替换为 `_`，空 → `'Root'`                                                                                                                                                                                                                                                        |

## 4. Algorithms（记忆核心算法类）

| 符号  | 签名                                                                                                                                                                                                                                                                                                                                               |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EPA` | `new EPA(basis?, config?)`；`project(vector) → {projections, probabilities, entropy, logicDepth, dominantAxes}`；`detectCrossDomainResonance(vector) → {resonance, bridges}`；`setBasis(basis)`；静态 `EPA.computeBasis(tags, dim, {clusterCount?, maxBasisDim?, strictOrthogonalization?}) → {orthoBasis, basisMean, basisLabels, basisEnergies}` |

- `logicDepth` = `1 − normalizedEntropy`（归一化熵 = entropy/log2(K)）；
  `dominantAxes` 为能量 > 0.05 的轴（含 label/energy/projection）；
  `resonance` = Σ `bridge.strength`（`√(e₁·e₂)` > 0.15）。
- 内部依赖 `clusterTags` → `computeWeightedPCA` → `selectBasisDimension`
  （95% 方差、最少 8 维）；默认 `dimension=3072`、`clusterCount=64`、
  `maxBasisDim=64`。

| `ResidualPyramid` | `new ResidualPyramid({maxLevels?=3, topK?=10, minEnergyRatio?=0.1, dimension?=3072})`；`analyze(queryVector, {searchFn, lookupFn})` → `{levels, totalExplainedEnergy, finalResidual, features}`；`extractFeatures(pyramid)` | 残差金字塔：每层残差子空间正交投影 + 握手特征（方向相干 / 模式强度 / 新颖度）；`features = {depth, coverage, novelty, coherence, tagMemoActivation, expansionSignal}` |

| `ResultDeduplicator` | `new ResultDeduplicator(loadVector?: ChunkVectorLoader, {dimension?, semanticThreshold?, maxResults?, minSemanticCandidates?, sourcePriority?})`；`deduplicate(candidates, queryVector?, {semantic?, semanticThreshold?, maxResults?, stage?})` → Promise<Array>；`hardDeduplicate(candidates)`；`updateConfig(...)` | 双层去重：承诺精确身份（chunkId/正文/path:chunkIndex）+ 余弦语义（默认 0.92） |
| `ResultDeduplicator.updateConfig` | `(config?)` | 热更新 resolution（维/clamp 阈值等） |

## 5. Gram-Schmidt 基元

| 符号                   | 签名 / 含义                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `dotProduct`           | `(v1: Float32Array, v2: Float32Array) → number`；`Σ v1[i]·v2[i]`                           |
| `magnitude`            | `(vec) → number`；`√(Σ v·v)`                                                               |
| `normalize`            | `(vec) → Float32Array`；单位化；模 < 1e-9 返回零向量                                       |
| `orthogonalize`        | `(vectors: Array<Float32Array>, dim) → {base: Float32Array[], coefficients: Float32Array}` | 改进 Gram-Schmidt；系数 = 原向量在与正交基内积的绝对值；近零向量排除 |
| `orthogonalProjection` | `(vector, tagVectors, dim) → {projection, residual, orthogonalBasis, coefficients}`        | 子空间总投影 + `residual = 原向量 − 投影`；残差金字塔核心            |

## 6. SVD / PCA

| 符号                   | 签名                                                                                                        | 数学含义                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `clusterTags`          | `(tags: Array<{id, name, vector}>, k, dim) → {vector: Float32Array[], labels: string[], weights: number[]}` | k-means：余弦相似度分配、Forgy 初始化、空质心最远点重初始化；最多 50 轮 / 容差 1e-4；标签取最近原始标签名 |
| `computeWeightedPCA`   | `(clusterData, dim, {maxBasisDim?, strictOrthogonalization?}) → {U, S, meanVector, labels}`                 | 加权（√权重缩放居中）Gram 阵 + 幂法逐本征对 + 收缩；`maxBasisDim` 默认 64；`U` 为映射回原维度的正交基     |
| `powerIteration`       | `(matrix: Float32Array, n, existingBasis?, strictOrthogonalization?) → {vector, value}`                     | 幂法（最多 100 轮）+ Rayleigh 商 + 与已有基再正交化 + 收敛容差 1e-6                                       |
| `selectBasisDimension` | `(S: number[]) → number`                                                                                    | 累计能量 < 总能量 95% 时取维数；保底 8 维                                                                 |

## 7. Topology（缩放场）

| 符号                    | 签名                                                                                                                                                                                                                                            | 含义                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildRowOperator`      | `(adjacency: Map<number, Map<number, weight>>, {weightFn?}) → {apply, applyDual, nodeIndexOf, nodeIdAt, nodeCount}`                                                                                                                             | 确定性行归一化线性算子：每行导纳除以行和，质量确定性扩散；`apply(vector, output?, diagnostics?) → Float64Array`                                    |
| `solveDualScaledFields` | `({localOperator?, transferOperator?, dualOperator?, sourceField, local?{alpha=0.15, maxIterations=80, tolerance=1e-9}, transfer?{alpha=0.55, ...}, support?{method='mass_ratio', massRatio=0.9}, localSupport?, transferSupport?}) → 冻结对象` | 双尺度固定点迭代 `u = (1−α)·S + α·T(u)`，两场同帧求解，输出 `{localField, transferField, localDomain, transferDomain, iterations, converged, ...}` |
| `normalizeSource`       | `(operator, sourceField: Map\|Array\|Float64Array) → Float64Array`                                                                                                                                                                              | 场量散射到算子节点空间并做质量单位化；空场抛 `TAGMEMO_V10_EMPTY_SOURCE`                                                                            |
| `effectiveSupport`      | `(vector, operator, {method?, massRatio?, ...}) → {method, ids, size, totalMass, retainedMass, retainedMassRatio, tailMass, entropy...}`                                                                                                        | 有效支撑域提取：`mass_ratio`（默认 0.9）/ `shannon` / `participation_ratio` / `spectral_gap`                                                       |

## 8. Topology（波传播）

| 符号                 | 签名                                                                                                                                                             | 含义                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `adjacencyFromEdges` | `(edges: [from, to, weight][]) → Map<id, Map<neighbor, weight>>`                                                                                                 | 边数组 → 邻接表（权重相加）                                                                                                                                                                                                                                                                                                                                                                                  |
| `computeFirWeights`  | `(gamma, maxSafeHops) → number[]`                                                                                                                                | FIR 抽头：`γ^hop` 规约至和为 1；γ 夹紧 [0.05, 0.95]，hop ∈ [0, maxSafeHops]                                                                                                                                                                                                                                                                                                                                  |
| `propagate`          | `({sources?, graph?, edges?, neighborFn?, residuals?, wormholeEdges?, config?}) → {activations: Map, fieldProvenance: Map, riverGraph, iterations, diagnostics}` | V9.1 软非回波传播（soft non-backtracking）：`config` 默认 `maxSafeHops=4 / baseMomentum=2.0（别名 momentum）/ firingThreshold=0.1 / baseDecay=0.25 / wormholeDecay=0.7 / tensionThreshold=1.0 / maxNeighborsPerNode=20 / returnFlowFactor=0.15 / firGamma=0.6 / maxPropagationStates=2000（别名 stateLimit）/ pruneAbove=0`；返回激活能量表、来源证明、河流图（schema `tagmemo-query-spike-river-v1`）与诊断 |

## 9. Topology（河流观测）

| 符号                        | 签名                                                                                                                                                                                                   | 含义                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `computeRiverObservability` | `(riverGraph, {kappaEdge?=0.5, kappaRatio?=0.3, epsilon?=0.02, collapsedThreshold?=0.12, sparseThreshold?=0.45, completeObservation?}) → {omega, regime: 'dense'\|'sparse'\|'collapsed', diagnostics}` | Ω 功能：边数比 × 涌现比 × 流熵的几何均值，三态分类查询河流拓扑密度 |

## 10. Utils

| 符号                      | 签名                                                                   | 说明                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `decodeVectorBlob`        | `(blob, dimension, label='vector', {logPrefix?}) → Float32Array\|null` | SQLite BLOB → Float32Array；字节数 `dim×4` 不符 → null；未对齐 Buffer 先复制                                      |
| `encodeVectorBlob`        | `(vector) → Buffer`                                                    | Float32Array → 视图范围 Buffer                                                                                    |
| `prepareTextForEmbedding` | `(text) → string`                                                      | 剥离装饰 emoji 和形如 `<x>` 的管道符，规整空白换行；空文本 → `'[EMPTY_CONTENT]'`                                  |
| `extractTags`             | `(content, config?, options?) → string[]`                              | 文末连续 `Tag:` 行解析；黑名单/超集黑名单/长度上限（中文 20 / 非中文 40）/日期剔除/去重/`maxTags` 截断（默认 50） |

验证视角：上述签名与 `dist/index.js` / `dist/index.d.ts` 实际产物逐项对照；行为验证见对应
`tests/algorithms/`、`tests/core/`、`tests/tdb/`、`tests/engine/`。
