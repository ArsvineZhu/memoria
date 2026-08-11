# 配置参考

本文是 `createMemoryEngine` 和 `TDBEngine` 的统一配置说明。默认值来自
`src/config/default-config.ts`，类型和回调来自 `src/types.ts`。
`mergeConfig` 会复制默认值；显式传入 `undefined` 不会覆盖默认值；普通对象（例如
`sourcePriority`）会合并，数组和普通值会整体替换。

检索开关、依赖、跳过条件和结果诊断字段的完整对应关系由
[检索能力矩阵](RETRIEVAL_FEATURES.md) 维护；本文保留可直接查配置值的参考表。

## 如何传入配置

```ts
const engine = createMemoryEngine({
  config: {
    dataPath: "./data",
    dimension: 128,
    topK: 5,
  },
  embeddingProvider,
  dbPath: "./data/memoria/memory.sqlite", // 顶层参数优先
});
```

检索默认策略不放入 `config` 或 `ragParams`，而是使用独立的构造选项
`defaultRetrievalPlan`：

```ts
const engine = createMemoryEngine({
  defaultRetrievalPlan: {
    strategy: "field",
    tagMemo: { plus: true, version: "v10" },
    postprocess: { dedupe: true, timeDecay: true },
  },
  embeddingProvider,
});
```

它只作用于 MemoryEngine 主检索链和 KnowledgeBaseAdapter 的文本搜索；TDBEngine 保持
独立语义。引擎构造时会复制、规范化并固定默认计划，调用者之后修改传入对象不会影响引擎，
也没有运行时 setter。单条 `search()` 可用 `retrievalPlan` 和
`inheritRetrievalDefaults: false` 覆盖或隔离它；完整规则见
[RETRIEVAL_PLAN.md](RETRIEVAL_PLAN.md)。

`options.dbPath` 优先于 `config.dbPath`。如果显式传入 `rootPath`、`storePath` 或
TDB 路径，它们也优先于 `dataPath` 派生的路径。`:memory:` 仍可作为明确的测试用
SQLite 路径。

## 路径

| 配置项         | 默认值                             | 用途                     |
| -------------- | ---------------------------------- | ------------------------ |
| `dataPath`     | `<cwd>/data`                       | 源文件和运行状态的总目录 |
| `rootPath`     | `<cwd>/data/content`               | 文件摄入源目录           |
| `storePath`    | `<cwd>/data/memoria/indexes`       | 主引擎向量索引目录       |
| `dbPath`       | `<cwd>/data/memoria/memory.sqlite` | 主引擎 SQLite 数据库     |
| `tdbRootPath`  | `<cwd>/data/knowledge`             | TDB 源目录               |
| `tdbStorePath` | `<cwd>/data/tdb/indexes`           | TDB 向量索引目录         |
| `tdbDbPath`    | `<cwd>/data/tdb/knowledge.sqlite`  | TDB SQLite 数据库        |

只要没有单独覆盖，`dataPath` 会派生以上六个路径。源文件、运行状态、备份和重建
规则见 [../data/README.md](../data/README.md)。

## 嵌入和向量存储

| 配置项              |                          默认值 | 用途                                                                                                             |
| ------------------- | ------------------------------: | ---------------------------------------------------------------------------------------------------------------- |
| `apiUrl`            |                            `""` | OpenAI 兼容接口的基础地址                                                                                        |
| `apiKey`            |                            `""` | 由调用方传入的 Provider 密钥                                                                                     |
| `model`             | `"google/gemini-embedding-001"` | 主模型名                                                                                                         |
| `modelSig`          |  `"gemini-embedding-2-preview"` | 用于缓存/配置识别的模型签名                                                                                      |
| `fallbackModels`    |                            `[]` | OpenAI 兼容接口的备用模型列表                                                                                    |
| `maxBatchItems`     |                            `32` | 主嵌入每批条数                                                                                                   |
| `maxToken`          |                          `8000` | 单条文本 token 上限                                                                                              |
| `concurrency`       |                             `5` | 主嵌入并行任务数                                                                                                 |
| `dimension`         |                          `3072` | 主向量维度                                                                                                       |
| `tagIndexCapacity`  |                         `50000` | 标签索引初始容量                                                                                                 |
| `indexSaveDelay`    |                        `120000` | 主索引延迟保存时间，单位毫秒                                                                                     |
| `tagIndexSaveDelay` |                        `300000` | 标签索引延迟保存时间，单位毫秒                                                                                   |
| `persistTagIndex`   |                         `false` | `true` 保存并恢复 `global_tags`；`false` 不落盘，clean recovery 从 SQLite authority 局部重建内存索引并删除旧文件 |
| `indexLoadEnabled`  |                            可选 | 兼容配置；`DEFAULT_CONFIG` 未提供默认值                                                                          |

Provider 的 `getDimension()` 必须等于 `config.dimension`。更换模型或维度后旧向量
空间不能直接复用，需要重新摄入；详见 [EMBEDDING.md](EMBEDDING.md)。

## SQLite 和摄入

| 配置项                 |  默认值 | 用途                                  |
| ---------------------- | ------: | ------------------------------------- |
| `busyTimeout`          | `10000` | SQLite 忙等待时间，单位毫秒           |
| `busyRetryDelay`       |   `100` | 重试间隔，单位毫秒                    |
| `chunkMaxTokens`       |   `600` | 单块最大 token 数                     |
| `chunkOverlapTokens`   |    `96` | 相邻块重叠 token 数                   |
| `maxTokens`            |   `600` | `chunkMaxTokens` 兼容别名             |
| `overlapTokens`        |    `96` | `chunkOverlapTokens` 兼容别名         |
| `tagBlacklist`         |    `[]` | 完全匹配的标签黑名单                  |
| `tagBlacklistSuper`    |    `[]` | 超集/正则标签黑名单                   |
| `maxTagsPerFile`       |    `50` | 每个文件最多标签数                    |
| `cooccurrenceRebuild`  | `false` | 摄入时是否重建标签共现关系            |
| `relationGraphEnabled` |  `true` | 是否从不可变源快照维护显式/派生关系图 |
| `checkpoint`           | `false` | 是否写摄入检查点                      |
| `checkpointInterval`   |     `1` | 每多少个文件写一次检查点              |

摄入层按“显式 `format` > 文件扩展名 > `text`”决定内容边界：`.mdx` 映射为 `mdx`，
`.md` 映射为 `markdown`，无路径的逻辑文档默认是 `text`。只有 `markdown`/`mdx` 解析
开头的 YAML front matter 和静态关系；`text` 中的 YAML、Markdown/Wiki 链接和
`MemoryLink` 都保留为正文，不会生成来源关系。`format: "text"` 可以覆盖 `.mdx`
扩展名。解析器不执行 JSX、`import` 或任意 MDX 代码。结构化格式的 `tags` 会进入现有
标签清理流程，其他字段会成为文档 metadata；front matter 会在分块和嵌入前移除。
用户源文件仍保持不可变，关系图等派生数据写入 SQLite/运行状态。

## 检索开关

| 配置项                         |  默认值 | 用途                               |
| ------------------------------ | ------: | ---------------------------------- |
| `epaProjectionEnabled`         |  `true` | EPA 语义投影                       |
| `residualPyramidEnabled`       |  `true` | 残差金字塔信号                     |
| `tagMemoV9Enabled`             | `false` | TagMemo V9 浪潮传播                |
| `tagMemoV10Enabled`            | `false` | TagMemo V10 缩放场传播             |
| `riverMemoEnabled`             | `false` | RiverMemo 状态重排                 |
| `topologyV3Enabled`            | `false` | RiverMemo Topology V3 原生关系重排 |
| `tagExpansionEnabled`          | `false` | 标签驱动候选扩展                   |
| `vectorReshapeEnabled`         | `false` | 向量重塑阶段                       |
| `geodesicRerankEnabled`        | `false` | 测地线重排                         |
| `associatorEnabled`            | `false` | 标签共现/向量关联                  |
| `externalRerankEnabled`        | `false` | 外部重排阶段                       |
| `useLLMRerank`                 | `false` | 外部重排兼容别名                   |
| `timeDecayEnabled`             | `false` | 时间衰减阶段                       |
| `truncateEnabled`              | `false` | 内容截断阶段                       |
| `expansionEnabled`             | `false` | 同文件扩展阶段                     |
| `fullDocumentExpansionEnabled` | `false` | 命中块所在父文件全文扩展           |

其他相关默认值：`geodesicAlpha: 0.3`、`geodesicMinGeoSamples: 4`、
`epaClusterCount: 64`、`epaMaxBasisDim: 64`、`epaPerCandidateAnalysis: false`、
`strictOrthogonalization: true`。

开关为 `true` 只表示 stage 会加入 pipeline。没有候选、标签图、向量、scope 或注入
依赖时，stage 仍可能跳过；请用 [检索能力矩阵](RETRIEVAL_FEATURES.md) 中的诊断字段
确认本次查询是否实际产生信号。

## 检索和融合

| 配置项                             |          默认值 | 用途                              |
| ---------------------------------- | --------------: | --------------------------------- |
| `topK`                             |             `5` | 最终返回条数                      |
| `perIndexK`                        |          `null` | 每个索引的候选数，默认跟随 `topK` |
| `indexNames`                       |          `null` | 指定主索引                        |
| `searchAllIndices`                 |         `false` | 是否搜索全部主索引                |
| `tagSearchEnabled`                 |         `false` | 是否启用标签检索                  |
| `tagIndexName`                     | `"global_tags"` | 标签索引名                        |
| `tagK`                             |            `10` | 标签候选数                        |
| `queryExpansion`                   |             `1` | 查询变体数                        |
| `queryEpsilon` / `epsilon`         |          `null` | 近零查询向量阈值别名              |
| `rephraserFn` / `queryRephraserFn` |          `null` | 调用方提供的查询改写函数          |
| `stopWords`                        |            `[]` | BM25 停用词                       |
| `tokenizer`                        |          `null` | 调用方提供的分词函数              |
| `bm25K1`                           |           `1.5` | BM25 词频饱和参数                 |
| `bm25B`                            |          `0.75` | BM25 长度归一化参数               |
| `bm25PoolK`                        |            `50` | BM25 候选池大小                   |
| `minScore`                         |             `0` | 融合结果最低分                    |
| `vectorWeight`                     |           `0.7` | 向量结果权重                      |
| `bm25Weight`                       |           `0.3` | BM25 结果权重                     |
| `hybridAlpha` / `hybridBeta`       |   `0.7` / `0.3` | TDB 兼容的融合别名                |

搜索调用可以临时覆盖 `topK`、范围、标签检索、权重、`minScore` 和时间衰减等常用
配置。范围优先级是调用参数 aliases（`indexNames` / `diaryNames` / `diaryName` /
`libraries`）> 配置默认值 > authority discovery > `Root` fallback；显式空数组是
空范围，不会回退到 `Root`。向量检索、BM25 和结果补全使用同一范围选择，行为说明见
[FUNCTIONS.md](FUNCTIONS.md)。

## 后处理

| 配置项                            |  默认值 | 用途                     |
| --------------------------------- | ------: | ------------------------ |
| `dedupeEnabled`                   |  `true` | 总去重开关               |
| `dedupeSemantic`                  |  `true` | 语义去重开关             |
| `semanticThreshold`               |  `0.92` | 语义重复的余弦阈值       |
| `dedupeMaxResults` / `maxResults` |  `1000` | 去重/结果池上限          |
| `minSemanticCandidates`           |     `2` | 触发语义去重的最少候选数 |
| `reranker`                        |  `null` | 调用方提供的外部重排函数 |
| `timeDecayHalfLife`               |    `90` | 时间衰减半衰期，单位天   |
| `timeDecayNow`                    |  `null` | 测试用当前时间覆盖值     |
| `timeDecayUpperBound`             |  `null` | 时间窗口上限             |
| `maxContentLength`                |   `800` | 截断后的正文长度         |
| `truncateEllipsis`                | `false` | 截断后是否加省略号       |
| `expandCount`                     |     `2` | 扩展种子数               |
| `expansionBoost`                  |  `1.15` | 扩展结果分数倍率         |
| `associateCount`                  |    `10` | 最多增加的关联块数       |
| `associatorSeeds`                 |     `3` | 关联种子数               |
| `associatorTagBoost`              |  `0.45` | 标签候选倍率             |
| `associatorVecK`                  |     `5` | 每个内容索引的向量邻居数 |
| `associatorVecBoost`              |   `0.3` | 向量候选倍率             |
| `associatorUseVector`             |  `true` | 是否启用向量关联         |

`sourcePriority` 的默认值为：

```json
{
  "rag": 50,
  "time": 45,
  "bm25_body": 40,
  "bm25_tag": 40,
  "continuity": 35,
  "associate": 10,
  "unknown": 0
}
```

它用于去重时选择代表结果，不等同于 `associateCount`。

## 记忆算法参数

| 分组        | 配置项和默认值                                                                                                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 残差金字塔  | `pyramidMaxLevels: 3`、`maxLevels: 3`、`pyramidTopK: 5`、`pyramidMinEnergyRatio: 0.1`、`minEnergyRatio: 0.1`                                                                                                                                                                                                 |
| TagMemo V9  | `maxSafeHops: 4`、`baseMomentum: 2.0`、`momentum: 2.0`、`firingThreshold: 0.1`、`baseDecay: 0.25`、`wormholeDecay: 0.7`、`tensionThreshold: 1.0`、`maxNeighborsPerNode: 20`、`branchLimit: 20`、`returnFlowFactor: 0.15`、`firGamma: 0.6`、`maxPropagationStates: 2000`、`stateLimit: 2000`、`pruneAbove: 0` |
| TagMemo V10 | `localAlpha: 0.15`、`transferAlpha: 0.55`、`localMaxIterations: 200`、`transferMaxIterations: 200`、`solverMaxIterations: 200`、`solverTolerance: 1e-9`、`supportMethod: "mass_ratio"`、`localMassRatio: 0.8`、`transferMassRatio: 0.9`、`pruneByEnergy: false`、`minFieldEnergy: 0`                         |
| RiverMemo   | `riverDecay: 1.0`、`riverTopologyCap: 0.08`                                                                                                                                                                                                                                                                  |

## TDB 冷知识库

| 配置项                  | 默认值                                  | 用途                                                                                                   |
| ----------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `tdbEnabled`            | `false`                                 | TDB 总开关                                                                                             |
| `tdbModel`              | `"google/gemini-embedding-001"`         | TDB 模型                                                                                               |
| `tdbDimension`          | `3072`                                  | TDB 向量维度                                                                                           |
| `tdbEmbeddingBatchSize` | `16`                                    | TDB 嵌入批大小                                                                                         |
| `tdbExtensions`         | `[".md",".mdx",".txt",".json",".html"]` | 支持的源文件扩展名                                                                                     |
| `tdbExcludeFolders`     | `["TDBdocs"]`                           | 排除的目录                                                                                             |
| `tdbSyncMode`           | `"normal"`                              | TDB 同步模式                                                                                           |
| `tdbForceQuery`         | `null`                                  | 兼容字段；查询模式默认由问题词自动判断，必要时用兼容字段 `tdbForceMode` 强制为 `question` 或 `keyword` |
| `tdbHybridAlpha`        | `0.7`                                   | TDB 向量融合权重                                                                                       |
| `tdbTopK`               | `10`                                    | TDB 返回条数                                                                                           |
| `tdbMinScore`           | `0.1`                                   | TDB 最低分                                                                                             |
| `tdbExpandDepth`        | `1`                                     | TDB 扩展深度                                                                                           |
| `tdbTimeDecayEnabled`   | `false`                                 | TDB 时间衰减                                                                                           |

## 兼容配置和 RAG 参数文件

`MemoryConfig` 还接受 `finalSemanticThreshold`、`tagExpansionBoost`、
`tagExpansionTopK`、`v91FirGamma`、`v91ReturnFlowFactor`、`textType`、
`timeoutMs`、`tdbForceMode`、`env` 和内部 `vexusIndex` 等兼容字段。这些字段
不是新的默认配置，只在已有适配层或 Provider 契约需要时使用。

`loadRagParams` 和 `loadRagParamsSync` 只读取调用方明确传入的 JSON 路径。文件根和
可选的 `KnowledgeBaseManager` 节都必须是 JSON 对象；文件不存在时返回空对象，
不会自行从环境变量发现路径。

## 环境变量

库源码不会自动加载 `.env`。测试和真实嵌入示例会自行读取环境变量；其中测试读取
仓库根目录 `.env`，召回 Demo 读取 `examples/real-embed/.env`。召回 Demo 支持：

| 变量                | 默认值                   | 作用                                          |
| ------------------- | ------------------------ | --------------------------------------------- |
| `EMBED_API_KEY`     | 无，必填                 | DashScope embedding 密钥                      |
| `EMBED_MODEL`       | `qwen3.7-text-embedding` | embedding 模型                                |
| `EMBED_DIMENSION`   | `1024`                   | embedding 向量维度                            |
| `EMBED_API_URL`     | DashScope 默认 endpoint  | 覆盖 embedding endpoint                       |
| `EMBED_CONCURRENCY` | `4`                      | embedding 请求并发数                          |
| `RERANK_API_URL`    | 无                       | `--external-rerank` 时必填的完整 Chat API URL |
| `RERANK_API_KEY`    | 无                       | `--external-rerank` 时必填                    |
| `RERANK_MODEL`      | 无                       | `--external-rerank` 时必填                    |
| `RERANK_TIMEOUT_MS` | `30000`                  | 外部 reranker 超时时间                        |

`EMBED_API_KEY` 缺失时真实 Demo 会在创建数据库前明确失败；三个 `RERANK_*` 必填项
只在显式传入 `--external-rerank` 时校验。密钥必须保留在本地，不能提交。库级配置
应通过 Provider 构造参数传入 `apiKey`。运行命令和外部正文发送提示见
[real-embed 示例](../examples/real-embed/README.md)。
