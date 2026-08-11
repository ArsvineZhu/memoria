# 检索能力矩阵

本文是 memoria 检索能力、配置开关和诊断字段的唯一完整说明。源码和公开类型是
行为的最终事实来源；本文负责把用户能开启什么、需要什么前提、什么时候会跳过以及
结果从哪里读出来串起来。项目没有运行时 `getCapabilities()` API；能力暴露通过本矩阵、
公开类型和可执行的真实嵌入演示完成。

策略选择和 VCP 能力迁移的完整用法见
[检索策略与 VCP 能力迁移](RETRIEVAL_STRATEGIES.md)。

## 能力总览

“默认值”表示普通 `createMemoryEngine()` 配置的默认值，不表示某次查询一定会产生
对应信号。阶段可能因为没有候选、没有标签图、没有向量、scope 为空或缺少注入依赖而
安全跳过。请同时查看“实际信号”列和搜索结果中的 trace 字段。

| 能力                  | 开关/入口                                                                    |                          默认值 | 依赖                                                 | 诊断字段                                                                                       | Demo 场景             |
| --------------------- | ---------------------------------------------------------------------------- | ------------------------------: | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------- |
| vector + BM25 hybrid  | `vectorWeight` / `bm25Weight`                                                |                         enabled | embedding、SQLite、Vexus                             | `vectorResults`、`bm25Results`                                                                 | 所有查询              |
| EPA                   | `epaProjectionEnabled`                                                       |                          `true` | tag vectors                                          | `epa`                                                                                          | 跨主题语义轴          |
| residual pyramid      | `residualPyramidEnabled`                                                     |                          `true` | tag vectors                                          | `pyramid`                                                                                      | 多事实查询            |
| TagMemo V9/V10        | `tagMemoV9Enabled` / `tagMemoV10Enabled` 或 `RetrievalPlan.strategy="field"` |                  `false` / auto | tag graph、tag vectors；文件型 SQLite 可用 Rust Memo | `tagMemo`、`nativeMemo`                                                                        | 标签联想              |
| RiverMemo（兼容）     | `riverMemoEnabled`                                                           |                         `false` | `riverStateStore`、tag river                         | `riverMemo`                                                                                    | 旧版连续查询轨迹      |
| RiverMemo Topology V3 | `RetrievalPlan.strategy="topology"` 或 `topologyV3Enabled`                   |                  `false` / auto | 文件型 SQLite、Vexus MemoRuntime                     | `riverMemo`、`topologyV3`、`topologyV3Skipped`                                                 | 关系/路径重排         |
| tag expansion         | `tagExpansionEnabled`                                                        |                         `false` | `global_tags`                                        | `tagExpansion`                                                                                 | 同义标签扩展          |
| vector rerank         | `vectorReshapeEnabled`                                                       |                         `false` | chunk vectors                                        | `vectorReshape`                                                                                | embedding 相似度重排  |
| geodesic rerank       | `geodesicRerankEnabled`                                                      |                         `false` | TagMemo activations                                  | `geodesic`、`geodesicSkipped`                                                                  | 标签能量重排          |
| same-file expansion   | `expansionEnabled` / `fullDocumentExpansionEnabled`                          |                         `false` | sibling chunks / parent document                     | `expansionStats`                                                                               | 上下文或全文补全      |
| association           | `associatorEnabled`                                                          |                         `false` | co-occurrence + vector store                         | `associatorStats`、`associationChannel`、`associationOf`                                       | 标签/向量相关记忆     |
| external rerank / RRF | `externalRerankEnabled` + `ctx.reranker`                                     |                         `false` | 外部 Chat API                                        | `reranked`、`rerankSkipped`、`rerankFailure`、`rerankError`、`rerankScore`、`externalRrfScore` | Rerank/Rerank+ 后处理 |
| time decay            | `timeDecayEnabled`                                                           |                         `false` | file timestamps                                      | candidate `decay`                                                                              | 新旧记忆排序          |
| dedupe/truncate       | `dedupeEnabled` / `truncateEnabled`                                          | dedupe `true`，truncate `false` | candidate vectors                                    | `dedupeStats`、`truncationStats`                                                               | 结果清理              |
| relation graph/filter | `retrievalPlan.filters` / `expansion.related` / `sameDocument` / `associate` |        filters 按请求，扩展关闭 | SQLite metadata、关系图、标签/向量                   | `retrievalFilter`、`relationExpansion`、`associatorStats`、`finalCandidates`                   | 范围约束和关联补全    |

### 开关与实际信号

开启开关只表示对应 stage 被加入 pipeline。它不保证每次查询都能使用该算法：

- EPA、residual pyramid 和 JS TagMemo 需要可用的标签向量或标签图；没有可分析的标签时，
  结果可能没有 `epa`、`pyramid` 或 `tagMemo`。
- 文件型 SQLite 上的 `field`/`topology` 计划会优先尝试 Rust MemoRuntime。`:memory:`
  或 native binding 不可用时，TagMemo 回落到 JS V9/V10；Topology V3 保留已有候选并设置
  `topologyV3Skipped`，不会把整次搜索变成错误。
- 兼容的 JS RiverMemo 需要 `ctx.riverStateStore`，并且每个调用者应根据自己的生命周期
  选择状态存储。没有状态存储时不会伪造轨迹统计。
- tag expansion 需要可查询的 `global_tags`；没有新增标签时也可能返回
  `tagExpansion: { added: [], boosted: [] }`。
- vector reshape 需要候选 chunk vector；`vectorReshape.traced` 中的 `checked`、
  `matched` 和 `skipped` 才能说明本次是否真正检查了向量。
- geodesic rerank 需要 TagMemo activation 和足够的样本；未满足条件时应读取
  `geodesicSkipped`，不能把“已开启”当成“已应用”。
- relation expansion 会在 scope 内沿显式/派生关系有界扩展，新增候选带有
  `source: "relation-expansion"`、距离、置信度和关系 ID；它在去重、外部重排、时间衰减
  和截断之前执行。
- `retrievalPlan.expansion.sameDocument` 负责同文档兄弟块展开，
  `retrievalPlan.expansion.associate` 负责标签共现和向量邻居联想；两者都在去重之前加入
  候选，并最终接受同一 scope 过滤。
- `retrievalPlan.expansion.fullDocument` 负责把命中块所在父文件按 chunk 顺序合并到种子
  结果；它不改写来源文件，且仍受同一 scope 和后处理尾链约束。
- association 会把新增候选标为 `associationChannel: "tag"` 或 `"vector"`，并在
  `associationOf` 中记录关联来源 chunk。`associatorStats.fromTags` 和
  `associatorStats.fromVector` 用于区分两条来源。
- `retrievalPlan.postprocess.minScore` 是截断阶段的分数下限，在外部重排和时间衰减之后
  执行；`maxResults` 与 `maxContentLength` 再限制数量和正文长度。
- external rerank 只有同时有显式开关和 `ctx.reranker` 时才调用。provider 失败、响应无
  合法分数或配置缺失时保留原排序，并设置 `rerankSkipped`；provider 异常使用
  `rerankFailure: "provider_error"`，兼容字段 `rerankError` 也只写这个安全码，不返回
  第三方异常原文、URL、响应体或异常中携带的查询内容。`lifecycle`/`concurrency` 控制错误继续抛出。
  `mode: "rrf"` 会把融合分数作为后续
  truncate、time decay 和最终格式化的有效 `score`，同时保留 `originalScore` 和
  `externalRrfScore` 诊断。

## Scope 语义

所有检索 stage 使用同一个已解析 scope，解析优先级为：

1. 调用参数 aliases；
2. config 默认值；
3. authority discovery；
4. `Root` fallback（仅旧调用兼容）。

`resolvedIndexNames: []` 是明确的空 scope，必须返回空结果；只有 `undefined` 才表示
尚未解析或是旧调用的兼容状态。`scopeSource` 会记录 `call`、`config`、`authority` 或
`fallback`，`scopeWasExplicit` 会指出调用者是否明确指定了 scope。BM25、vector tag
search、TagExpander 和 association candidates 都必须使用这个结果，不能各自猜测范围。

## 配置示例

下面的配置只列出检索能力相关的完整开关集合；embedding provider、SQLite 和 Vexus
仍需按 [配置参考](CONFIGURATION.md) 配置。普通库默认关闭增强阶段，示例把它们全部
打开，便于检查诊断字段：

```ts
import { createMemoryEngine } from "memoria";
import type { ExternalReranker, PipelineContextOptions } from "memoria";

declare const reranker: ExternalReranker;
declare const riverStateStore: NonNullable<PipelineContextOptions["riverStateStore"]>;

const engine = createMemoryEngine({
  config: {
    dataPath: "./data",
    rootPath: "./data/content",
    storePath: "./data/memoria/indexes",
    dimension: 1024,
    persistTagIndex: true,
    searchAllIndices: true,
    tagSearchEnabled: true,
    vectorWeight: 0.7,
    bm25Weight: 0.3,
    epaProjectionEnabled: true,
    residualPyramidEnabled: true,
    tagMemoV9Enabled: true,
    tagMemoV10Enabled: true,
    riverMemoEnabled: true,
    tagExpansionEnabled: true,
    vectorReshapeEnabled: true,
    geodesicRerankEnabled: true,
    expansionEnabled: true,
    associatorEnabled: true,
    dedupeEnabled: true,
    externalRerankEnabled: true,
    timeDecayEnabled: true,
    timeDecayNow: Date.parse("2026-08-10T06:00:00Z"),
    timeDecayHalfLife: 90,
    truncateEnabled: true,
    reranker,
  },
  ctx: { riverStateStore, reranker },
  dbPath: "./data/memoria/memory.sqlite",
});
```

`ctx.reranker` 的公开契约是：输入原始 query 和只读候选数组，返回重新排序的
`ChunkCandidate[]`，候选可以附带新的 `score`。stage 会把合法分数写入候选的
`rerankScore`，未被服务返回的候选稳定地排在后面。外部适配器可以把其他协议转换成
这个契约；本仓库的 50 文件 demo 提供
`createOpenAICompatibleReranker()`，使用 OpenAI-compatible Chat API。

```ts
export type ExternalReranker = (
  query: string,
  results: readonly ChunkCandidate[],
) => readonly ChunkCandidate[] | Promise<readonly ChunkCandidate[]>;
```

## 公开类型

根入口 `memoria` 导出以下与检索增强和诊断有关的类型，应用可以据此声明自己的
provider、stage hook 和结果处理器：

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

`SearchEnvelope` 的 `results` 之外，还可以读取 `vectorResults`、`bm25Results`、
`epa`、`pyramid`、`tagMemo`、`riverMemo`、`tagExpansion`、`vectorReshape`、
`geodesic`、`associatorStats`、`dedupeStats`、`truncationStats`、`expansionStats`、
`reranked`、`rerankSkipped`、`rerankFailure` 和兼容字段 `rerankError`。单条 `SearchResult` 还会保留
`associationChannel`、`associationOf` 和 `rerankScore`（有值时出现）。

## 50 文件真实嵌入 Demo

真实演示使用 `data/content/recall-demo/` 中正好 50 篇标准 MDX，按固定的 24 条
direct、paraphrase、cross-topic、multi-hop 和 fuzzy qrels 比较 `baseline`、
`enhanced/local`，以及显式开启后的 `external` pipeline：

```powershell
corepack pnpm demo:real-embed -- --reset --limit 50 --top-k 5
```

结果打印每种模式的 gold、top-k、分数、路径、标题、标签和上述 trace，并写入
`data/memoria/recall-demo/results.json`。`--limit 1..50` 只用于 smoke test；不带
`--limit` 时必须摄入全部 50 篇。查询 embedding 在三种模式间使用进程内 cache。

外部 rerank 不是默认行为，只有显式使用 `--external-rerank` 且配置
`RERANK_API_URL`、`RERANK_API_KEY`、`RERANK_MODEL` 才会调用第三方服务：

```powershell
corepack pnpm demo:real-embed -- --external-rerank --top-k 5
```

候选会包含截断正文、标题、标签和相对路径，可能暴露个人知识库内容并产生第三方
API 费用；请只对允许外发的语料使用。普通 provider 失败只标记
`rerankSkipped`/`rerankFailure: "provider_error"`，不会抹掉 baseline 或 local 结果；
运行前提、环境变量、输出 JSON 和重跑行为见
[real-embed 示例](../examples/real-embed/README.md)。

## 相关文档

- [配置参考](CONFIGURATION.md)：所有配置键、默认值、scope 和环境变量。
- [公开 API](API.md)：导出符号、`SearchEnvelope` 和 provider 契约。
- [持久化](PERSISTENCE.md)：SQLite、派生索引、tag index 和恢复边界。
- [功能行为](FUNCTIONS.md)：摄入、检索 stage 和 postprocess 的行为说明。
