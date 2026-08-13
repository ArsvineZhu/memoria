# Public API 参考

## Root runtime exports

memoria 的 runtime export 精确为：

```text
createMemoryEngine
MemoryEngine
QueryBuilder
TDBEngine
TDBStore
TriviumDBAdapter
```

ESM 和 CJS root entry 保持相同 allowlist。root 不导出 pipeline、stage、planner helper、算法 primitive 或内部 native runtime。

## Public type groups

root types 包括：

- EngineState、EngineStats；
- MemoryConfig、MemoryConfigOverrides、MemoryEngineOptions；
- MemoryDocument*、SearchOptions、SearchEnvelope、SearchResult；
- RetrievalPlan、RetrievalPlanInput、RetrievalStrategy、RetrievalExplanation；
- EmbeddingProviderContract、ExternalReranker、MetadataStoreContract、VectorStoreContract 和 relation contracts；
- MdxDocument、MdxFrontmatter、正式 data/error types；
- 全部 TDB contracts 和 TDB result types。

完整导出列表由 [src/index.ts](../../src/index.ts) 维护，public declaration 测试负责防止 root 泄漏内部类型。

## MemoryEngine methods

```text
initialize()
reconcile()
flushBatch()
ingest()
upsert()
ingestBatch()
remove()
flush()
search()
query()
explain()
handleDelete()
deleteFile()
getStats()
listFiles()
close()
```

所有需要 SQLite、vector index 或 provider 的方法都要求 engine 已经处于 ready 状态；
否则抛出 lifecycle error。除非特别说明，返回值是 Promise。

| 方法                       | 参数                        | 返回值/作用                                                                                     |
| -------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| `initialize()`             | 无                          | 打开/验证 metadata、vector store 和 provider；可重复调用。schema 不匹配时抛 persistence error。 |
| `reconcile()`              | 无                          | 依据 metadata authority 重建 derived vector state，返回 `ReconciliationReport`。                |
| `flushBatch(files?)`       | `FileInput`、数组、路径或空 | 摄入文件快照，返回每个文件的 `IngestEnvelope`。                                                 |
| `ingest(document)`         | `MemoryDocumentInput`       | 摄入逻辑文档，返回 `MemoryDocumentIngestResult`。                                               |
| `upsert(document)`         | `MemoryDocumentInput`       | 显式替换/更新逻辑文档；metadata-only 更新可复用已有向量。                                       |
| `ingestBatch(documents)`   | 逻辑文档数组                | 批量返回 ingest result。                                                                        |
| `remove(documentId)`       | 稳定逻辑文档 ID             | 删除逻辑文档及其 chunks，返回 `MemoryDocumentDeleteResult`。                                    |
| `flush(files?)`            | 与 `flushBatch` 相同        | 文件摄入别名。                                                                                  |
| `search(query, options?)`  | 查询字符串、`SearchOptions` | 返回 `SearchEnvelope`，包括 results、diagnostics 和 retrieval trace。                           |
| `query(query)`             | 查询字符串                  | 返回 immutable `QueryBuilder`；`run()` 才执行搜索。                                             |
| `explain(query, options?)` | 查询字符串、`SearchOptions` | 解析策略、plan、readiness 和 trace，不执行完整检索。                                            |
| `handleDelete(input)`      | 文件路径或 `FileInput`      | 删除文件快照和派生 chunk，返回 `DeleteEnvelope`。                                               |
| `deleteFile(path)`         | 文件路径                    | `handleDelete({ path })` 的便捷写法。                                                           |
| `getStats()`               | 无                          | 返回 files、chunks、tags、spaces、vectorStats、healthy 和 initialized。                         |
| `listFiles()`              | 无                          | 返回 metadata authority 中的文件快照，不读取或修改源文件。                                      |
| `close()`                  | 无                          | flush pending vector saves、关闭 stores；可重复调用。                                           |

当前没有 `removeBatch()` 或独立的 `getHealthStatus()`；健康状态在 `getStats().healthy`。
`handleDelete`/`deleteFile` 面向文件源，`remove` 面向逻辑文档，不能混用 ID 和路径。

最小生命周期：

```ts
const engine = createMemoryEngine({ embeddingProvider });
try {
  await engine.initialize();
  await engine.ingest({ id: "note:1", content: "正文", format: "mdx" });
  const result = await engine.search("正文", { topK: 5 });
  await engine.remove("note:1");
  await engine.flush();
  console.log(result.results);
} finally {
  await engine.close();
}
```

## MemoryEngineOptions

正式注入入口包括：

```ts
createMemoryEngine({
  config,
  defaultRetrievalPlan,
  dbPath,
  embeddingProvider,
  vectorStore,
  metadataStore,
  reranker,
  searchOptions,
  onReady,
});
```

reranker 是运行时 provider injection，不属于 MemoryConfig。配置对象不接受未知 key，也不接受 ctx、旧 loader path 或开放式 option bag。

## QueryBuilder

核心选择：

```text
using  auto  semantic  associative  structural
```

阶段选择：

```text
tagBasisProjection
tagResidualDecomposition
activationPropagation
graphDiffusion
propagationSupport
propagationStructure
propagationHistory
embeddingRerank
tagExpansion
nativeTagRetrieval
structuralRelations
```

组合与执行：

```text
where  expand  rerank  postprocess
withoutDefaults  withDefaults  toPlan  run
```

builder immutable；ScopeBuilder、ExpansionBuilder、RerankBuilder 和 PostprocessBuilder 是 callback 内部使用的 builder，不是 root runtime exports。

方法语义：

| 方法                                                                  | 作用                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------ |
| `using(indexNames)`                                                   | 指定要搜索的 vector index。                                  |
| `auto()`/`semantic()`/`associative()`/`structural()`                  | 选择 retrieval strategy。策略冲突会在规范化时失败。          |
| `tagBasisProjection()`、`tagResidualDecomposition()`                  | 请求对应 tag 分析阶段。                                      |
| `activationPropagation()`、`graphDiffusion()`、`propagationHistory()` | 请求图传播、diffusion 和 history；传播顺序固定。             |
| `propagationSupport()`、`propagationStructure()`、`embeddingRerank()` | 请求本地确定性重排。                                         |
| `tagExpansion()`、`structuralRelations()`                             | 请求 tag/relation expansion。                                |
| `nativeTagRetrieval()`                                                | 请求 native tag retrieval capability；不暴露 native handle。 |
| `where(callback)`                                                     | 设置 spaces、document、时间和 metadata scope/filter。        |
| `expand(callback)`                                                    | 设置同文档、relation 或关联候选扩展。                        |
| `rerank(callback)`                                                    | 设置 external rerank selection、mode 和 alpha。              |
| `postprocess(callback)`                                               | 设置 dedupe、time decay、minScore、limit 和内容长度。        |
| `withoutDefaults()`/`withDefaults()`                                  | 控制是否继承 engine default retrieval plan。                 |
| `toPlan()`                                                            | 返回规范化的 immutable plan，不执行搜索。                    |
| `run()`                                                               | 以当前 plan 调用同一个 engine search 生命周期。              |

没有 chain 等价物的能力包括 `initialize`、`reconcile`、文件系统 `scan/sync`、
`listFiles`、`getStats` 和 `close`；这些仍应直接调用正式 API。

## TDBEngine、TDBStore 与 TriviumDBAdapter

TDBEngine 的公开生命周期/数据方法包括：

```text
initialize()  reconcile()  upsertText()  upsertFile()
removeFile()  removeText()  search()  searchWithVector()
listLibraries()  getStats()  close()
```

TDB 使用 `libraries` 和 TDB 专属 config，不使用主 engine 的 `spaces` 作为同义词。
`TDBStore({ dbPath })` 提供 TDB metadata contract 和 `close()`；
`TriviumDBAdapter` 可接入正式 store/vector contract，但不把内部 stage 作为 public API。

## Filesystem 与 errors subpaths

```ts
import FilesystemIngestionAdapter from "@arsvinezhu/memoria/adapters/filesystem";

const adapter = new FilesystemIngestionAdapter(engine, {
  rootPath: "./content",
  extensions: [".mdx"],
});
await adapter.scan();
await adapter.sync();
await adapter.removeFile("journal/note.mdx");
await adapter.close();
```

`scan` 读取源，`sync` 将变化提交给 engine，`removeFile` 删除 authority 中对应文件，
`close` 停止 watcher。错误从 `@arsvinezhu/memoria/errors` 导入；持久化 schema、provider、维度和
lifecycle 错误都应按错误 code 处理，而不是依赖 message 文本。

## 正式 subpaths

- @arsvinezhu/memoria/adapters/filesystem：MDX/文件快照读取、scan、sync、watch 和删除。
- @arsvinezhu/memoria/errors：MemoriaError 及稳定错误 code。
- @arsvinezhu/memoria/providers/openai-compatible：协议兼容 embedding provider、reranker factory 和 reranker error types。

其他源码路径不是 package contract。教程和消费者测试只使用 root 或上述 subpaths。
