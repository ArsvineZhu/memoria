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

## Retrieval gates

### Tag and graph retrieval

```text
tagBasisProjectionEnabled
tagResidualDecompositionEnabled
tagGraphPropagationEnabled
propagationSupportRerankEnabled
propagationStructureRerankEnabled
propagationHistoryEnabled
nativeTagRetrievalEnabled
tagExpansionEnabled
```

### Expansion and reranking

```text
embeddingRerankEnabled
relationExpansionEnabled
relationGraphEnabled
expansionEnabled
fullDocumentExpansionEnabled
associatorEnabled
externalRerankEnabled
externalRerankMode = ordered | rrf
externalRerankAlpha
```

### Postprocess and search

```text
timeDecayEnabled
truncateEnabled
truncateMinScore
timeDecayHalfLife
timeDecayNow
maxContentLength
minScore
dedupeEnabled
dedupeSemantic
semanticThreshold
maxResults
vectorWeight
bm25Weight
```

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
