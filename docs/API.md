# 公开 API

本文只记录当前 canonical contract。根入口的运行时导出保持 ESM/CJS 完全一致；
内部 pipeline、stage、算法 primitive、native facade 和工具类型不属于根入口。

## 根运行时导出

<!-- runtime-exports:start -->

createMemoryEngine
MemoryEngine
QueryBuilder
TDBEngine
TDBStore
TriviumDBAdapter
<!-- runtime-exports:end -->

`Object.keys(import("memoria"))` 和 `Object.keys(require("memoria"))` 只应包含上面
六个运行时名称。根类型声明另外提供正式的 options/config、retrieval plan/explanation、
search/result/document、provider/store injection、relation/data/error 和 TDB contracts；
这些类型不会把内部 stage graph 或 native payload 暴露给消费者。

## 子路径

| 子路径                                | 用途                                                 |
| ------------------------------------- | ---------------------------------------------------- |
| `memoria/adapters/filesystem`         | 扫描、读取和监听文件源；写入仍由 `MemoryEngine` 负责 |
| `memoria/errors`                      | `MemoriaError`、错误码和 `asMemoriaError`            |
| `memoria/providers/openai-compatible` | OpenAI-compatible embedding 和 reranker provider     |

filesystem adapter 和错误契约是正式 subpath，不会回收到根运行时导出。

## MemoryEngine

```ts
import { createMemoryEngine } from "memoria";

const engine = createMemoryEngine({
  config: { dataPath: "./data", dimension: 128, topK: 5 },
  embeddingProvider,
});

await engine.initialize();
await engine.ingest({ id: "note:1", content: "...", revision: "1" });
const envelope = await engine.search("查询文本", { topK: 5, spaces: ["Root"] });
await engine.remove("note:1");
await engine.close();
```

`MemoryEngineOptions` 只接受正式的 `config`、`defaultRetrievalPlan`、`dbPath`、
`embeddingProvider`、`reranker`、`vectorStore`、`metadataStore`、`searchOptions` 和
`onReady` 注入。不存在开放式 option bag、上下文逃生口或外部配置文件 loader。

`searchOptions` 提供 engine 级默认的 query expansion 参数；单次 `search()` 传入的
`queryExpansion` 和 `queryEpsilon` 会覆盖这些默认值。检索过滤与 external rerank
只属于 canonical `retrievalPlan.filters` 和 `retrievalPlan.externalRerank`；不存在
`SearchOptions.retrievalFilters` 或 `SearchOptions.externalRerank` 兼容别名。

模型 rerank provider 通过 `reranker` 注入，并由本次查询的 `RetrievalPlan` 显式开启：

```ts
import { createMemoryEngine } from "memoria";
import { createOpenAICompatibleReranker } from "memoria/providers/openai-compatible";

const engine = createMemoryEngine({
  embeddingProvider,
  reranker: createOpenAICompatibleReranker({
    apiUrl: "https://provider.example/v1/chat/completions",
    apiKey: "your-api-key",
    model: "reranker-model",
  }),
  defaultRetrievalPlan: {
    strategy: "semantic",
    externalRerank: { enabled: true },
  },
});
```

不注入 provider 或计划未开启 `externalRerank.enabled` 时，external rerank stage 只透传
候选，不会访问网络。`MemoryConfig` 只提供 reranker 的运行参数，不拥有本次查询的 stage
selection authority。

常用生命周期方法为 `initialize()`、`ingest()`、`ingestBatch()`、`upsert()`、
`remove()`、`search()`、`query()`、`explain()`、`flush()`、`flushBatch()`、
`reconcile()`、`getStats()`、`listFiles()`、`handleDelete()`、`deleteFile()` 和
`close()`。
文件源需要使用 `memoria/adapters/filesystem`；逻辑文档直接使用 `ingest`/`remove`。

## RetrievalPlan

策略只有：

```ts
type RetrievalStrategy = "auto" | "semantic" | "associative" | "structural";
```

计划由 `associative`、`structural`、独立的 `propagationHistory`、`filters`、
`externalRerank`、`expansion` 和 `postprocess` 组成。不存在版本选择字段或旧策略
section。`QueryBuilder` 只生成同一份 JSON-like `RetrievalPlanInput`，例如：

```ts
const result = await engine
  .query("来源和关联")
  .structural()
  .propagationStructure()
  .structuralRelations()
  .postprocess((postprocess) => postprocess.dedupe().limit(8))
  .run();
```

`RetrievalExplanation` 记录规范化计划和策略分数；返回信封中的 `retrieval` 只提供稳定
的 strategy、strategySource、plan、evidence channel 和 capability fallback。内部阶段顺序
和 raw stage payload 不属于公开契约。

## canonical search/result 字段

搜索信封的核心字段是 `results`、`resultCount` 和可选的 `retrieval`。结果可包含
`documentId`、`content`、`path`、`space`、`score`、
`similarity`、`tagMatchScore`、`matchedTags`、`decay`、`associationChannel`、
`associationOf`、`rerankScore`、`metadata`、`sourceMetadata`、`sourceUpdatedAt`、
`recordedAt` 和 `indexedAt`。

标签检索的内部阶段数据不会透传到 SearchEnvelope；公开诊断通过 `retrieval.evidence`
和 `retrieval.fallbacks` 表达能力与降级状态。时间字段统一为 Unix epoch milliseconds。

## Native boundary

Rust/N-API 只通过由 `VexusVectorStore` 内部解析的 tag-retrieval runtime 调用。发布 ABI
固定为 `rebuildTagGraphArtifact`、`runTagRetrievalPipeline`、`runActivationPropagation`、
`rerankByPropagationSupport`、`rerankByPropagationStructure`、
`clearTagRetrievalRuntime` 和 `tagRetrievalRuntimeStats`；辅助方法固定为
`computeTagBasis`、`publishTagBasisCache`、`computeTagResidualMetrics`、
`computeTagPairSimilarities`、`projectTagBasis`、`computeResidualDirections`、
`projectDiffusionDistributions` 和 `fuseTagContext`。应用不应直接注入 native index。

## Errors

```ts
import { MemoriaError, asMemoriaError } from "memoria/errors";
```

持久化错误使用 `MemoriaError("persistence", ...)`。canonical SQLite schema 不匹配时，
引擎会要求重新创建数据库；不会迁移、自动删除或双写旧 schema。完整错误边界和
恢复规则见 [PERSISTENCE.md](PERSISTENCE.md) 与 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

## TDB

`TDBEngine`、`TDBStore`、`TriviumDBAdapter` 和其正式 contracts 保持 TDB library 语义，
使用独立的调用方配置路径和配置。TDB 类型不会混入主 MemoryEngine 的 retrieval plan。
