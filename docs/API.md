# API — 导出符号参考（dist/index.js）

> 参考对象：编译后的 `dist/index.js`（源入口为 `index.ts`）。符号列表来自实际执行（逐字粘贴）：
>
> ```js
> Object.keys(require('C:/dev/memoria'))
> ```
>
> 分组名与 `index.ts` 顶部注释一致，共 10 组；每个符号给出签名 / 参数 / 返回 /
> 默认值。类型标注以 TypeScript 源码和 `dist/index.d.ts` 为准。

## 0. 全量导出清单（实测输出）

```text
Pipeline, Stage, PipelineContext, createMemoryEngine, MemoryEngine,
DEFAULT_CONFIG, mergeConfig, loadRagParams, loadRagParamsSync,
RAG_PARAMS_DEFAULTS, KnowledgeBaseAdapter, TDBEngine, TDBSearchPipeline,
TDBStore, TriviumDBAdapter, resolveLibrary, safeLibraryName, EPA,
ResidualPyramid, ResultDeduplicator, dotProduct, magnitude, normalize,
orthogonalize, orthogonalProjection, clusterTags, computeWeightedPCA,
powerIteration, selectBasisDimension, buildRowOperator,
solveDualScaledFields, normalizeSource, effectiveSupport, propagate,
computeFirWeights, adjacencyFromEdges, computeRiverObservability,
decodeVectorBlob, encodeVectorBlob, prepareTextForEmbedding, extractTags
```

（共 41 个导出符号；下列分组按 `index.ts` 注释划分）

## 1. Core

| 符号 | 签名 | 说明 |
|------|------|------|
| `Pipeline` | `new Pipeline(stages = [])`；`run(initialInput, ctx) → Promise<unknown>`；`pipe(stage)`；`replace(stageName, newStage)` | 阶段串行编排器。每个 stage 的输出作为下一个的输入 |
| `Stage` | 抽象类；子类实现 `async process(input, ctx)` | 所有阶段基类；未实现 `process` 抛错 |
| `PipelineContext` | `new PipelineContext({config, embeddingProvider, vectorStore, metadataStore, vexusIndex?, epa?, riverStateStore?, tagGraph?})` | 跨阶段共享的 DI 容器；`vexusIndex` 为 Rust N-API 句柄、`epa` 预构建 EPA 基、`tagGraph` 标签共现图 |

## 2. 引擎工厂 + 配置加载

| 符号 | 签名 | 说明 |
|------|------|------|
| `createMemoryEngine(options?)` | `options: {config?, dbPath?, ragParamsPath?, ragParams?, embeddingProvider?, vectorStore?, metadataStore?, ctx?, ingestOptions?, deleteOptions?, searchOptions?, onReady?}` → `MemoryEngine` | 工厂：构建（不打开）引擎 |
| `MemoryEngine` | `new MemoryEngine(options)` | 引擎类，生命周期方法见下 |
| `DEFAULT_CONFIG` | 对象 | 全量默认配置（字段表见 GUIDE.md §3） |
| `mergeConfig(userConfig)` | `(object\|null\|undefined) → object` | 默认合并：一层深合并对象、整替换数组/标量、`undefined` 不覆盖 |
| `loadRagParams({path?, overrides?, defaults?})` | `→ Promise<object>` | 从 rag_params.json 异步加载（缺失文件 → `{}`；根必须为对象） |
| `loadRagParamsSync({path?, overrides?, defaults?})` | `→ object` | 同步变体；文件不存在则跳过 |
| `RAG_PARAMS_DEFAULTS` | `{}` | 默认装载基 |
| `KnowledgeBaseAdapter` | `new KnowledgeBaseAdapter({engine})` （engine 必填，否则 TypeError） | KBM 兼容层，方法见 FUNCTIONS §10（下节） |

**MemoryEngine 实例方法**（类型与实现摘自 `src/engine.ts`）：

- `initialize()` — Promise<void>；幂等、并发共享
- `flushBatch(files)` | `flush(files)` — Promise<Array<object>>（每文件信封）
- `search(query, options?)` — Promise<object>（`{ ..., results, resultCount }`）
- `handleDelete(input)` | `deleteFile(filePath)` — Promise<object>（`{ deleted, fileId, removedChunkIds }`）
- `getStats()` — Promise<{files, chunks, tags, diaries, lastIndexed, vectorStats, healthy, initialized}>
- `close()` — Promise<void>；幂等

**KnowledgeBaseAdapter 方法面**：`initialize / shutdown / flush / flushBatch /
handleDelete / deleteFile / getStats / close / removeDocument / search /
getMemoryProfile / getHealthStatus / runExternalFileMutation /
deduplicateResults / getEPAAnalysis / applyTagBoostAsync /
rerankWithTagMemoAsync / rerankWithRiverMemoAsync / getDiaryDateIndex /
getDiaryNameVector / getVectorByText / getVectorByChunkId /
getChunksByFilePaths`，另有只读 `initialized` / `db` / `config` 属性
（legacy search 的向量路径返回 `{chunkId, text, score, sourceFile, fullPath,
matchedTags, tagMatchCount, coreTagsMatched, boostFactor, tagMatchScore}`）。

## 3. TDB 冷知识库（Phase 6）

| 符号 | 签名 | 说明 |
|------|------|------|
| `TDBEngine` | `new TDBEngine({config?, metadataStore?, vectorStore?, embeddingProvider?, trivium?, searchOptions?})` | 冷知识库引擎。方法：`initialize() → Promise<boolean>`、`upsertText(text, options?)`、`upsertFile(filePath, options?)`、`removeFile(input)`、`removeText(options)`、`search(queryText, options?)`、`searchWithVector(vec, queryText, options?)`、`listLibraries()`、`getStats()`、`close()` |
| `TDBSearchPipeline` | `new TDBSearchPipeline(config, options?)`；`run({query, vector?, options?}, ctx)` | TDB 查询链（`tdbQueryNormalizer` → queryEmbed → 双路召回 → 融合 → [timeDecay] → `tdbResultFormatter`）；`tdbEnabled=false` 返回 `{tdbDisabled:true, results:[], resultCount:0}` |
| `TDBStore` | `new TDBStore({dbPath, busyTimeout?, busyRetryDelay?})` | TDB 元数据：`upsertFile/getFile/getFileById/getFileByChunkId/deleteFile/insertChunks/getChunks/getChunkById/getAllChunks/listLibraries/getDistinctDiaryNames/getMeta/setMeta/healthCheck/close` |
| `TriviumDBAdapter` | `new TriviumDBAdapter({vectorStore?, metadataStore?, indexName?, dimension?, idSeq?})` | 本地原生调用面代理：`insert(vector, payload?, options?)/submit/delete/search/searchHybrid/link/indexText/buildTextIndex/flush/stats`；无服务端 |
| `resolveLibrary` | `(rootPath: string, absPath: string) → {library: string, relPath: string}` | 根相对路径首段 = library，否则 `'Root'` |
| `safeLibraryName` | `(name: string) → string` | 非法文件名替换为 `_`，空 → `'Root'` |

## 4. Algorithms（记忆核心算法类）

| 符号 | 签名 |
|------|------|
| `EPA` | `new EPA(basis?, config?)`；`project(vector) → {projections, probabilities, entropy, logicDepth, dominantAxes}`；`detectCrossDomainResonance(vector) → {resonance, bridges}`；`setBasis(basis)`；静态 `EPA.computeBasis(tags, dim, {clusterCount?, maxBasisDim?, strictOrthogonalization?}) → {orthoBasis, basisMean, basisLabels, basisEnergies}` |

  - `logicDepth` = `1 − normalizedEntropy`（归一化熵 = entropy/log2(K)）；
  `dominantAxes` 为能量 > 0.05 的轴（含 label/energy/projection）；
  `resonance` = Σ `bridge.strength`（`√(e₁·e₂)` > 0.15）。
  - 内部依赖 `clusterTags` → `computeWeightedPCA` → `selectBasisDimension`
    （95% 方差、最少 8 维）；默认 `dimension=3072`、`clusterCount=64`、
    `maxBasisDim=64`。

| `ResidualPyramid` | `new ResidualPyramid({maxLevels?=3, topK?=10, minEnergyRatio?=0.1, dimension?=3072})`；`analyze(queryVector, {searchFn, lookupFn})` → `{levels, totalExplainedEnergy, finalResidual, features}`；`extractFeatures(pyramid)` | 残差金字塔：每层残差子空间正交投影 + 握手特征（方向相干 / 模式强度 / 新颖度）；`features = {depth, coverage, novelty, coherence, tagMemoActivation, expansionSignal}` |

| `ResultDeduplicator` | `new ResultDeduplicator(db?, {dimension?, semanticThreshold?, maxResults?, minSemanticCandidates?, sourcePriority?})`；`deduplicate(candidates, queryVector?, {semantic?, semanticThreshold?, maxResults?, stage?})` → Promise<Array>；`hardDeduplicate(candidates)`；`updateConfig(...)` | 双层去重：承诺精确身份（chunkId/正文/path:chunkIndex）+ 余弦语义（默认 0.92） |
| `ResultDeduplicator.updateConfig` | `(config?)` | 热更新 resolution（维/clamp 阈值等） |

## 5. Gram-Schmidt 基元

| 符号 | 签名 / 含义 |
|------|------|
| `dotProduct` | `(v1: Float32Array, v2: Float32Array) → number`；`Σ v1[i]·v2[i]` |
| `magnitude` | `(vec) → number`；`√(Σ v·v)` |
| `normalize` | `(vec) → Float32Array`；单位化；模 < 1e-9 返回零向量 |
| `orthogonalize` | `(vectors: Array<Float32Array>, dim) → {base: Float32Array[], coefficients: Float32Array}` | 改进 Gram-Schmidt；系数 = 原向量在与正交基内积的绝对值；近零向量排除 |
| `orthogonalProjection` | `(vector, tagVectors, dim) → {projection, residual, orthogonalBasis, coefficients}` | 子空间总投影 + `residual = 原向量 − 投影`；残差金字塔核心 |

## 6. SVD / PCA

| 符号 | 签名 | 数学含义 |
|------|------|----------|
| `clusterTags` | `(tags: Array<{id, name, vector}>, k, dim) → {vector: Float32Array[], labels: string[], weights: number[]}` | k-means：余弦相似度分配、Forgy 初始化、空质心最远点重初始化；最多 50 轮 / 容差 1e-4；标签取最近原始标签名 |
| `computeWeightedPCA` | `(clusterData, dim, {maxBasisDim?, strictOrthogonalization?}) → {U, S, meanVector, labels}` | 加权（√权重缩放居中）Gram 阵 + 幂法逐本征对 + 收缩；`maxBasisDim` 默认 64；`U` 为映射回原维度的正交基 |
| `powerIteration` | `(matrix: Float32Array, n, existingBasis?, strictOrthogonalization?) → {vector, value}` | 幂法（最多 100 轮）+ Rayleigh 商 + 与已有基再正交化 + 收敛容差 1e-6 |
| `selectBasisDimension` | `(S: number[]) → number` | 累计能量 < 总能量 95% 时取维数；保底 8 维 |

## 7. Topology（缩放场）

| 符号 | 签名 | 含义 |
|------|------|------|
| `buildRowOperator` | `(adjacency: Map<number, Map<number, weight>>, {weightFn?}) → {apply, applyDual, nodeIndexOf, nodeIdAt, nodeCount}` | 确定性行归一化线性算子：每行导纳除以行和，质量确定性扩散；`apply(vector, output?, diagnostics?) → Float64Array` |
| `solveDualScaledFields` | `({localOperator?, transferOperator?, dualOperator?, sourceField, local?{alpha=0.15, maxIterations=80, tolerance=1e-9}, transfer?{alpha=0.55, ...}, support?{method='mass_ratio', massRatio=0.9}, localSupport?, transferSupport?}) → 冻结对象` | 双尺度固定点迭代 `u = (1−α)·S + α·T(u)`，两场同帧求解，输出 `{localField, transferField, localDomain, transferDomain, iterations, converged, ...}` |
| `normalizeSource` | `(operator, sourceField: Map\|Array\|Float64Array) → Float64Array` | 场量散射到算子节点空间并做质量单位化；空场抛 `TAGMEMO_V10_EMPTY_SOURCE` |
| `effectiveSupport` | `(vector, operator, {method?, massRatio?, ...}) → {method, ids, size, totalMass, retainedMass, retainedMassRatio, tailMass, entropy...}` | 有效支撑域提取：`mass_ratio`（默认 0.9）/ `shannon` / `participation_ratio` / `spectral_gap` |

## 8. Topology（波传播）

| 符号 | 签名 | 含义 |
|------|------|------|
| `adjacencyFromEdges` | `(edges: [from, to, weight][]) → Map<id, Map<neighbor, weight>>` | 边数组 → 邻接表（权重相加） |
| `computeFirWeights` | `(gamma, maxSafeHops) → number[]` | FIR 抽头：`γ^hop` 规约至和为 1；γ 夹紧 [0.05, 0.95]，hop ∈ [0, maxSafeHops] |
| `propagate` | `({sources?, graph?, edges?, neighborFn?, residuals?, wormholeEdges?, config?}) → {activations: Map, fieldProvenance: Map, riverGraph, iterations, diagnostics}` | V9.1 软非回波传播（soft non-backtracking）：`config` 默认 `maxSafeHops=4 / baseMomentum=2.0（别名 momentum）/ firingThreshold=0.1 / baseDecay=0.25 / wormholeDecay=0.7 / tensionThreshold=1.0 / maxNeighborsPerNode=20 / returnFlowFactor=0.15 / firGamma=0.6 / maxPropagationStates=2000（别名 stateLimit）/ pruneAbove=0`；返回激活能量表、来源证明、河流图（schema `tagmemo-query-spike-river-v1`）与诊断 |

## 9. Topology（河流观测）

| 符号 | 签名 | 含义 |
|------|------|------|
| `computeRiverObservability` | `(riverGraph, {kappaEdge?=0.5, kappaRatio?=0.3, epsilon?=0.02, collapsedThreshold?=0.12, sparseThreshold?=0.45, completeObservation?}) → {omega, regime: 'dense'\|'sparse'\|'collapsed', diagnostics}` | Ω 功能：边数比 × 涌现比 × 流熵的几何均值，三态分类查询河流拓扑密度 |

## 10. Utils

| 符号 | 签名 | 说明 |
|------|------|------|
| `decodeVectorBlob` | `(blob, dimension, label='vector', {logPrefix?}) → Float32Array\|null` | SQLite BLOB → Float32Array；字节数 `dim×4` 不符 → null；未对齐 Buffer 先复制 |
| `encodeVectorBlob` | `(vector) → Buffer` | Float32Array → 视图范围 Buffer |
| `prepareTextForEmbedding` | `(text) → string` | 剥离装饰 emoji / `<|x|>` 管道符、规整空白换行；空 → `'[EMPTY_CONTENT]'` |
| `extractTags` | `(content, config?, options?) → string[]` | 文末连续 `Tag:` 行解析；黑名单/超集黑名单/长度上限（中文 20 / 非中文 40）/日期剔除/去重/`maxTags` 截断（默认 50） |

验证视角：上述签名与 `dist/index.js` 实际导出逐项对照；行为验证见对应
`tests/algorithms/`、`tests/core/`、`tests/tdb/`、`tests/engine/`。
