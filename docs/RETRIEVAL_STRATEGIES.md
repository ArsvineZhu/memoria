# 检索策略与 VCP 能力迁移

字段级 API 参考见 [RETRIEVAL_PLAN.md](RETRIEVAL_PLAN.md)，文件源与关系生命周期见
[RELATIONS.md](RELATIONS.md)。本文保留能力迁移视角，说明旧能力如何落到这些原生
契约上。

本文是 memoria 原生检索策略的使用说明。用户只需要提交普通字符串查询；查询中不使用
VCP 的标签、占位符或 modifier，也不使用 query MDX。需要固定算法时，通过
`RetrievalPlan` 这个类型化 API 指定。

## 一句话对应关系

| VCP 原能力                         | memoria 的用户入口                                                                                                                   | 内部实现                                                                                | 适合的问题                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ----------------------------------- |
| `TagMemo` / `TagMemo+`             | `strategy: "field"`，或普通主题/标签查询自动选择                                                                                     | TagMemo V9 波传播 + V10 双尺度场；文件型 SQLite 优先走 Rust Memo，原生不可用时回落到 TS | “哪些记忆谈同一主题/概念？”         |
| `RiverMemo::Rerank+` / Topology V3 | `strategy: "topology"`，并组合 `externalRerank: { enabled: true, mode: "rrf" }`；或由“关联、路径、沿着、来源”等查询自动选择 Topology | Rust MemoRuntime 观测 + RiverMemo Topology V3 原生重排，再接可选外部 RRF                | “这份记忆和另一份记忆是什么关系？”  |
| 外层过滤                           | `filters`                                                                                                                            | 向量、BM25、扩展和最终候选共用同一允许集合                                              | 空间、文档身份、时间、metadata 限制 |
| 外层扩展                           | `expansion.related`、`sameDocument`、`fullDocument`、`associate`                                                                     | SQLite 关系图有界多跳、同文档兄弟块、父文件全文、标签/向量联想                          | 找关联记忆、补全文档、发现共现      |
| `::Time`、去重、截断、外部重排     | `postprocess`、`externalRerank`                                                                                                      | 时间衰减、去重、分数阈值/数量/正文截断、RRF/有序外部重排                                | 对召回结果作独立整理                |

`TagMemo`、`RiverMemo` 仍会出现在结果 trace 中，表示算法来源和可观测性；它们不是
新的查询语法。

## 自动选择

```ts
const result = await engine.search("沿着实验记录的关联路径，找出它的来源");
```

`profileNaturalLanguageQuery()` 只读取普通字符串，提取关系、顺序、时间、主题和直接
引用等确定性信号；`planRetrieval()` 根据这些信号选择：

- 路径、来源、关联、直接引用 → `topology`；
- 标签、主题、概念、关键词 → `field`；
- 没有专门信号 → `semantic`；
- 时间词会独立打开 time decay，不会把时间查询误判成拓扑查询。

搜索结果信封会保留 `retrievalPlan`、`queryProfile` 和 `retrievalDecision`，因此应用可以
知道本次为什么选了某条路径。自动选择是可解释的规则规划，不是假装拥有通用语言模型的
深层理解；应用若有明确意图，应使用显式计划。

## 显式指定算法

```ts
const result = await engine.search("量子纠缠实验", {
  retrievalPlan: {
    strategy: "field",
    tagMemo: {
      enabled: true,
      plus: true,
      version: "v10",
      geodesicRerank: true,
    },
    filters: {
      spaces: ["research"],
      metadata: { status: "active" },
    },
    expansion: {
      related: true,
      maxHops: 1,
      maxAdded: 20,
      sameDocument: true,
      associate: true,
    },
    postprocess: {
      timeDecay: true,
      dedupe: true,
      truncate: true,
      minScore: 0.4,
      maxResults: 8,
      maxContentLength: 3000,
    },
  },
});
```

如果要固定 RiverMemo/Topology V3：

```ts
const result = await engine.search("这份记忆和设计稿的关系", {
  retrievalPlan: {
    strategy: "topology",
    topology: { enabled: true, version: "v3", maxHops: 2 },
    riverMemo: { enabled: true, rerank: true, version: "v3" },
    expansion: { related: true, maxHops: 2, maxAdded: 30 },
    externalRerank: { enabled: true, mode: "rrf", alpha: 0.35 },
  },
});
```

这里的 `externalRerank` 才对应旧 `Rerank+`。它需要 `ctx.reranker`；缺少服务或
服务失败时保留 Topology 候选并报告 `rerankSkipped` 与安全码
`rerankFailure: "provider_error"`，不会让普通外部依赖成为主检索的单点故障；
生命周期/并发控制错误仍会向上抛出。

显式计划优先于自然语言自动选择。空的 `filters.spaces: []` 是有意的空范围，会返回空
结果，不会偷偷回退到 `Root`。没有显式计划时，旧的配置开关仍保持兼容；文件型 SQLite
上的自动 Topology 会优先使用原生实现。

## 默认策略与链式写法

可以在创建 `MemoryEngine` 时设置固定的默认计划：

```ts
const engine = createMemoryEngine({
  defaultRetrievalPlan: {
    strategy: "field",
    tagMemo: { plus: true, version: "v10" },
    postprocess: { timeDecay: true },
  },
  embeddingProvider,
});
```

之后普通 `engine.search(query)` 和 `KnowledgeBaseAdapter.search(query)` 文本入口都会继承
它。单查询 `retrievalPlan` 覆盖核心策略；外层过滤、扩展、外部重排和后处理按字段继承。
`inheritRetrievalDefaults: false` 可隔离默认，`strategy: "auto"` 可显式重新启用自动选择。
向量兼容重载和 TDBEngine 不进入这套计划系统。

同一计划也可以用分组 Builder 表达：

```ts
const result = await engine
  .query("沿着实验记录的关系找来源")
  .topology()
  .riverMemoRerankPlus({ alpha: 0.35 })
  .where((s) => s.space("research"))
  .expand((e) => e.related({ maxHops: 2 }).fullDocument())
  .postprocess((p) => p.timeDecay().dedupe().limit(8))
  .run();
```

`.tagMemoPlus()` 和 `.riverMemoRerankPlus()` 只是规范化计划的快捷配方；Builder 不复制
stage 执行逻辑，`.toPlan()` 可以用于检查最终计划。每个调用都返回新 Builder，冲突的
`field`/`topology` 声明会显式报错。需要序列化、跨语言或动态生成时，继续使用
JSON-like `RetrievalPlanInput`。

## MDX 源与关系图

用户维护的 MDX 是不可变源。摄入时只静态解析开头的 front matter 和普通链接，不执行
JSX、`import` 或任意 MDX 代码。正文去掉 front matter 后才分块、嵌入和检索。

```mdx
---
title: 实验记录
tags: [量子纠缠, 实验]
status: active
---

本次实验沿用了[上一版方案](./previous-design.mdx)。
```

解析出的来源链接写入 SQLite 的关系图；库还提供
`RelationGraphStore.addDerivedRelations()`，供系统的推断/反馈作业把关联另写为
`derived` 关系，带有 confidence、evidence、provenance、algorithm version 和 active
状态。内置摄入流程只维护来源关系，不会在每次查询中偷偷写入关系。系统不会把辅助
链接回写到 MDX；来源文件可以继续由用户、Git 或其他编辑器独立管理。

关系扩展只读取有界的关系图。显式来源链接优先于派生关系；派生关系可以停用或重新生成，
不会改变用户源文件。

## 后处理顺序

一次搜索的边界顺序是：

1. 先解析 scope，并让向量召回、BM25 和 tag search 使用同一个范围；
2. 执行语义/field/topology 主策略；
3. 执行关系扩展、同文档/全文扩展和关联候选；
4. 去重；
5. 可选外部有序重排或 RRF；
6. 可选时间衰减；
7. 分数阈值、最终数量和正文长度限制；
8. 再次应用候选过滤并格式化结果。

因此，扩展出来的记忆不会绕过去重、时间衰减、分数阈值或截断；过滤也不会只作用于某一路召回。

## 原生能力与安全降级

Rust MemoRuntime 需要能被 Rust 打开的文件型 SQLite 路径，例如默认的
`data/memoria/memory.sqlite`。原生路径会：

1. 从 SQLite 事实层和派生表重建/复用带签名的 Memo artifact；
2. 对当前查询生成 `observationHandle`；
3. 让 DTSC/Topology V3 读取同一份查询观测；
4. 把 Topology V3 的 `omega`、geometry、observables、direct-anchor 和排序结果带回
   `riverMemo`/`topologyV3` trace。

`:memory:` 或缺少原生 binding 时，TagMemo+ 会回落到现有 TS V9/V10；Topology V3 会保留
已有候选并设置 `topologyV3Skipped` 与原因，不会把一次增强失败变成整次搜索失败。若
应用要求“必须原生 Topology”，应在调用方检查该诊断字段。

## 从旧 VCP 调用迁移

旧的：

```text
query + ::TagMemo+ + ::Time + ::Expand
```

改成：

```ts
engine.search(query, {
  retrievalPlan: {
    strategy: "field",
    tagMemo: { enabled: true, plus: true, version: "v10" },
    expansion: { related: true, fullDocument: true, maxHops: 1 },
    postprocess: { timeDecay: true },
  },
});
```

旧的：

```text
query + ::RiverMemo + ::Rerank+
```

改成：

```ts
engine.search(query, {
  retrievalPlan: {
    strategy: "topology",
    riverMemo: { enabled: true, rerank: true, version: "v3" },
    externalRerank: { enabled: true, mode: "rrf", alpha: 0.5 },
  },
});
```

旧 `::Expand` 的语义是返回命中块所在父文件的全文，因此使用
`expansion.fullDocument: true`；`sameDocument: true` 只表示补入同文件的兄弟块，适合
仍按 chunk 返回的场景。

这不是 VCP 应用层的复制：应用只看到稳定的普通查询、typed plan、关系图和结果 trace，
不需要维护 VCP 标签占位符或 modifier 字符串。
