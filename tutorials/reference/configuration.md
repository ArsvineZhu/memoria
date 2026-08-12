# Configuration 参考

## 配置对象规则

MemoryConfigOverrides 等于 Partial<MemoryConfig>。createMemoryEngine({ config }) 会把 override 合并到默认配置；未知 key 立即抛出 TypeError。配置不保存函数型 provider，provider 必须通过 options 注入。

## 默认身份与存储

常用字段：

```text
dataPath
rootPath
storePath
dbPath
dimension
topK
tagVectorIndexName = tag_vectors
persistTagVectorIndex
```

dataPath 只表示消费者自己的运行时目录。它可以派生默认 rootPath、storePath、dbPath，但不会让仓库数据成为 package 内容。

## RetrievalPlan selection

检索阶段选择不再由 `MemoryConfig` 的 `*Enabled` 字段控制。调用方使用
`defaultRetrievalPlan` 设置 engine 级默认，使用 `SearchOptions.retrievalPlan` 设置单次
查询计划；字段定义和组合示例见 [RetrievalPlan reference](retrieval-plan.md)。

```ts
const result = await engine.search("来源关系", {
  retrievalPlan: {
    strategy: "structural",
    structural: { enabled: true, propagationStructure: true },
    externalRerank: { enabled: true, mode: "rrf", alpha: 0.5 },
    postprocess: { timeDecay: true, dedupe: true, truncate: true },
  },
});
```

`MemoryConfig` 保留运行参数，例如 `externalRerankMode`、`externalRerankAlpha`、
`timeDecayHalfLife`、`timeDecayNow`、`maxContentLength`、`truncateMinScore`、
`dedupeSemantic`、`semanticThreshold`、`maxResults`、`vectorWeight` 和 `bm25Weight`。
计划是本次查询的唯一 selection authority；未被计划选中的 capability 不会被 base config
反向打开。

### Basis, residual, propagation and diffusion parameters

```text
tagBasisClusterCount
tagBasisMaxDimensions
tagBasisPerCandidateAnalysis
strictOrthogonalization
residualMaxSteps
residualTagTopK
residualStopEnergyRatio
propagationMaxHops
routingBudget
activationThreshold
standardEdgePropagationFactor
shortcutEdgePropagationFactor
shortcutEdgeThreshold
shortcutEdgeGain
shortcutEdgeReserveMass
maxNeighborsPerNode
returnActivationFactor
hopReadoutGamma
maxPropagationStates
minimumInjectedActivation
localDiffusionAlpha
extendedDiffusionAlpha
diffusionMaxIterations
localDiffusionTolerance
extendedDiffusionTolerance
supportSelectionMethod
localSupportMassRatio
extendedSupportMassRatio
historyUpdateScale
historyRerankCap
supportRerankAlpha
supportRerankMinSamples
```

具体默认值以 [src/config/default-config.ts](../../src/config/default-config.ts) 为准；算法解释见 [algorithms](../algorithms/README.md)。

## TDB configuration

TDB 使用独立字段：

```text
tdbEnabled
tdbRootPath
tdbStorePath
tdbDbPath
tdbModel
tdbDimension
tdbEmbeddingBatchSize
tdbExtensions
tdbExcludeFolders
tdbSyncMode
tdbForceQuery
tdbHybridAlpha
tdbTopK
tdbMinScore
tdbExpandDepth
tdbTimeDecayEnabled
```

TDB library 与 MemoryEngine space 不是同一概念；不要混用 libraries 和 spaces。
