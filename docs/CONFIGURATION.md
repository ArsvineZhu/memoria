# 配置

配置事实以 `src/config/default-config.ts` 和 `src/types.ts` 为准。`MemoryConfigOverrides`
等于 `Partial<MemoryConfig>`；合并时只接受 `MemoryConfig` 已声明的键，未知键直接抛出
`TypeError`。不存在旧配置文件 loader、开放式 option bag 或隐式 fallback key。

## 路径和模型

```ts
const engine = createMemoryEngine({
  config: {
    dataPath: "./data",
    dimension: 1024,
    topK: 5,
    model: "embedding-model",
  },
  embeddingProvider,
});
```

| 键                   | 默认值                             | 作用                                            |
| -------------------- | ---------------------------------- | ----------------------------------------------- |
| `dataPath`           | `<cwd>/data`                       | 派生 `rootPath`、`storePath`、`dbPath` 的根路径 |
| `rootPath`           | `<dataPath>/content`               | 文件系统 adapter 的源目录                       |
| `storePath`          | `<dataPath>/memoria/indexes`       | 主向量索引目录                                  |
| `dbPath`             | `<dataPath>/memoria/memory.sqlite` | 主 SQLite 数据库                                |
| `dimension`          | `3072`                             | embedding 维度；必须与 provider 一致            |
| `model` / `modelSig` | 空字符串                           | provider 模型和持久化签名                       |
| `topK`               | `5`                                | 默认返回条数                                    |
| `tagVectorIndexName` | `tag_vectors`                      | canonical tag vector index 名称                 |

顶层 `options.dbPath` 是 `config.dbPath` 的明确注入入口。修改维度、模型签名、数据库
或索引目录时，应使用新的 SQLite/vector-index 目录并重新摄入；本次命名 reset 不迁移
旧数据库或 derived artifacts。

## canonical retrieval gates

以下开关是检索增强的唯一命名：

| 开关                                |  默认值 | 负责的阶段                     |
| ----------------------------------- | ------: | ------------------------------ |
| `tagBasisProjectionEnabled`         |  `true` | tag basis projection           |
| `tagResidualDecompositionEnabled`   |  `true` | tag residual decomposition     |
| `tagGraphPropagationEnabled`        | `false` | activation propagation         |
| `propagationSupportRerankEnabled`   | `false` | propagation support reranker   |
| `propagationStructureRerankEnabled` | `false` | propagation structure reranker |
| `propagationHistoryEnabled`         | `false` | persistent propagation history |
| `embeddingRerankEnabled`            | `false` | embedding reranker             |
| `nativeTagRetrievalEnabled`         | `false` | Rust tag-retrieval runtime     |
| `tagExpansionEnabled`               | `false` | tag expansion                  |
| `relationExpansionEnabled`          | `false` | relation expansion             |

其他正式开关包括 `associatorEnabled`、`externalRerankEnabled`、`timeDecayEnabled`、
`dedupeEnabled`、`truncateEnabled`、`expansionEnabled`、`fullDocumentExpansionEnabled`、
`relationGraphEnabled`、`checkpoint` 和 `persistTagVectorIndex`。它们只在
`MemoryConfig` 中声明的类型范围内配置。

## basis、residual、propagation、diffusion 和 history

相关参数使用同一组 canonical 名称：

```ts
const config = {
  tagBasisClusterCount: 64,
  tagBasisMaxDimensions: 64,
  tagBasisPerCandidateAnalysis: false,
  strictOrthogonalization: true,
  residualMaxSteps: 3,
  residualTagTopK: 5,
  residualStopEnergyRatio: 0.1,
  propagationMaxHops: 4,
  routingBudget: 20,
  activationThreshold: 0.1,
  maxNeighborsPerNode: 20,
  returnActivationFactor: 0.15,
  hopReadoutGamma: 0.6,
  maxPropagationStates: 2000,
  localDiffusionAlpha: 0.15,
  extendedDiffusionAlpha: 0.55,
  diffusionMaxIterations: 200,
  localDiffusionTolerance: 1e-9,
  extendedDiffusionTolerance: 1e-9,
  supportSelectionMethod: "mass_ratio",
  localSupportMassRatio: 0.8,
  extendedSupportMassRatio: 0.9,
  historyUpdateScale: 1,
  historyRerankCap: 0.08,
  supportRerankAlpha: 0.3,
  supportRerankMinSamples: 4,
} satisfies MemoryConfigOverrides;
```

`MemoryConfig` 还包含普通 hybrid search、scope、dedupe、expansion、time decay、
external rerank 和 TDB 参数。请直接以类型声明和 default config 为完整清单；本文不
保留已删除的版本选择或历史别名。

## spaces

文件持久化身份使用 `space`/`spaces`。文件表列是 `files.space`，搜索选项使用
`SearchOptions.spaces`，metadata store 方法是 `getDistinctSpaces()`，统计字段是
`spaces`；metadata API 不接受非 canonical 的旧身份键。

## TDB

TDB 仍使用自己的正式 library 术语和配置：`tdbEnabled`、`tdbRootPath`、`tdbStorePath`、
`tdbDbPath`、`tdbModel`、`tdbDimension`、`tdbTopK` 等。TDB 的 SQLite/vector index
与主 MemoryEngine 分离；完整入口见 [API.md](API.md)。

## Provider 和注入

`embeddingProvider` 必须提供 `embedBatch()`、`getDimension()`，并可选提供 `embed()`。
`reranker` 是可选的 `ExternalReranker` 函数注入；只有同时开启
`externalRerankEnabled` 才会执行。正式替换边界是 `VectorStoreContract` 和
`MetadataStoreContract`。provider/store/reranker 只通过 `MemoryEngineOptions` 注入；
native runtime 由内部 backend resolution 获取，应用不能把 native index 作为公开 option
传入。
