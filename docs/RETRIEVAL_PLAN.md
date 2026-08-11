# RetrievalPlan：用类型化计划选择算法

检索入口只有两部分：普通字符串查询和可选的 `RetrievalPlan`。查询字符串中不写
VCP 标签、占位符、modifier，也不写查询 MDX。需要固定算法时，把意图写成对象；
不指定时由 `strategy: "auto"` 根据查询画像和当前图/原生能力做可解释选择。

## 策略含义

| `strategy` | 内部能力                                                   | 适合的问题                 |
| ---------- | ---------------------------------------------------------- | -------------------------- |
| `semantic` | vector + BM25 基础混合检索                                 | 直接找一段内容             |
| `field`    | TagMemo V9/V10 字段传播；`plus` 还启用 geodesic/DTSC 读出  | 同主题、同概念、标签场     |
| `topology` | RiverMemo Topology V3；文件型 SQLite 优先 Rust MemoRuntime | 来源、路径、关联、直接证据 |
| `auto`     | 由自然语言画像在上述三者中选择                             | 入口不确定或希望默认行为   |

`TagMemo` 和 `RiverMemo` 是 trace 中的算法/来源名称，不是用户必须学习的查询
语法。`TagMemo+` 对应 `field + tagMemo.plus + geodesicRerank`；它不是外部
rerank。原 VCP 的组合 `RiverMemo::Rerank+` 则拆成
`topology + riverMemo.rerank + externalRerank: { mode: "rrf" }`：前者是
Topology V3，后者才是外部 Reranker 与原检索排名的 RRF。没有注入
`ctx.reranker` 时，RRF 层会保留 Topology 结果并留下 `rerankSkipped` 诊断；普通 provider
异常使用 `rerankFailure: "provider_error"`，生命周期/并发控制错误继续抛出。

## 最小调用

```ts
const result = await engine.search("量子纠缠实验的共同主题", {
  retrievalPlan: {
    strategy: "field",
    tagMemo: { enabled: true, plus: true, version: "v10" },
  },
});
```

```ts
const result = await engine.search("沿着实验记录找出最早来源", {
  retrievalPlan: {
    strategy: "topology",
    topology: { enabled: true, version: "v3", maxHops: 2 },
    riverMemo: { enabled: true, rerank: true, version: "v3" },
  },
});
```

只要 TagMemo 浪潮、不启用 `+` 的显式写法是：

```ts
const result = await engine.search("实验记录的主题", {
  retrievalPlan: {
    strategy: "field",
    tagMemo: { enabled: true, plus: false, version: "v9" },
  },
});
```

显式的 `semantic`、`field` 或 `topology` 会覆盖自动决策；计划中的其他部分仍然
可以独立组合。

## 引擎默认计划与单查询覆盖

`MemoryEngineOptions.defaultRetrievalPlan` 是构造阶段固定的可部分填写计划。它会被立即
复制、规范化为 `engine.defaultRetrievalPlan`，非法策略或参数会在构造时抛出 `TypeError`；
后续不能通过 setter 修改。没有配置时，默认核心策略仍是 `auto`，普通查询继续由自动规划器
在 `semantic`、`field` 和 `topology` 之间选择。这个选项不进入 MDX、query text、
`ragParams` 或普通 stage config，也不作用于 TDBEngine。

```ts
const engine = createMemoryEngine({
  defaultRetrievalPlan: {
    strategy: "field",
    tagMemo: { plus: true, version: "v10" },
    expansion: { related: true },
    postprocess: { timeDecay: true, dedupe: true },
  },
  embeddingProvider,
});

await engine.search("量子实验"); // field + 默认 TagMemo/扩展/后处理
await engine.search("这份记录的来源", {
  retrievalPlan: {
    strategy: "topology",
    riverMemo: { enabled: true, rerank: true, version: "v3" },
    postprocess: { timeDecay: false },
  },
});
```

解析优先级是：

```text
单查询 retrievalPlan > 链式 Builder 覆盖 > engine.defaultRetrievalPlan > 库内置 auto
```

`inheritRetrievalDefaults` 默认为 `true`。核心 `strategy` 是替换式选择：从 `field` 切到
`topology` 时，默认 TagMemo 核心配置不继续生效；`filters`、`expansion`、
`externalRerank`、`postprocess` 则按字段继承。`spaces`、`documentIds` 数组和 `metadata`
在查询中出现时整体替换；`spaces: []` 仍是 fail-closed 空范围；明确的 `false` 会关闭对应
默认能力。

若只需要这一条查询重新进入自动规划，可显式写 `strategy: "auto"`。若要完全不看引擎默认，
使用：

```ts
await engine.search("只做普通语义检索", {
  inheritRetrievalDefaults: false,
  retrievalPlan: { strategy: "semantic" },
});
```

解析使用纯函数 `mergeRetrievalPlan(defaultPlan, override?, inheritDefaults?)`，默认计划和
查询输入均在进入 pipeline 前脱离调用者对象；pipeline 不会原地修改它们。

## 分组链式查询

`engine.query(query)` 只是 JSON-like 计划的不可变 Builder，不创建第二套执行路径。每个
方法返回新 Builder，可以从同一基础查询分支；`.run()` 最终调用现有 `engine.search()`，
`.toPlan()` 返回合并后的规范化计划。`.run()` 不接受第二个 retrieval plan；动态或跨语言
场景继续直接使用普通对象。

```ts
const result = await engine
  .query("实验记录和设计方案之间的来源关系")
  .using("topology")
  .riverMemo({ version: "v3" })
  .rerank((r) => r.rrf({ alpha: 0.35 }))
  .where((s) =>
    s.space("research").document("experiment-2026").metadata({ status: "active" }),
  )
  .expand((e) => e.related({ maxHops: 2, maxAdded: 30 }).fullDocument().associate())
  .postprocess((p) => p.timeDecay().dedupe().limit(8).maxContentLength(3000))
  .run();
```

常用快捷方式：

```ts
await engine.query("量子实验的共同主题").tagMemoPlus({ version: "v10" }).run();
// { strategy: "field", tagMemo: { enabled: true, plus: true, version: "v10" } }

await engine.query("这份记录的来源").riverMemoRerankPlus({ alpha: 0.35 }).run();
// topology + riverMemo v3 + externalRerank mode "rrf"
```

分组 Builder 包含 `where`（`space`、`document`、`recordedAfter`、`recordedBefore`、
`metadata`）、`expand`（`related`、`sameDocument`、`fullDocument`、`associate`）、
`rerank`（`ordered`、`rrf`）和 `postprocess`（`timeDecay`、`dedupe`、`truncate`、
`minScore`、`limit`、`maxContentLength`）。这些分组也接受对象形式。重复声明互相冲突的
核心策略会在 `.toPlan()` 或 `.run()` 抛出明确的 `TypeError`，不会静默采用最后一次调用。

Builder 生成的计划与直接 `engine.search()` 使用同一份 trace：其中包含规范化的
`defaultPlan`、`requestedPlan`、最终 `plan`、`strategySource`、继承/覆盖标记、自然语言
`profile`、`decision`、实际 `stageOrder` 和 `fallbacks`。`engine.explain(query, options?)`
可在不执行召回、不写入关系图或源文件的情况下读取同一套计划解析和 readiness 诊断。

## 完整组合

```ts
const result = await engine.search("实验记录与设计方案的关系", {
  retrievalPlan: {
    strategy: "topology",
    topology: { enabled: true, version: "v3", maxHops: 2 },
    riverMemo: { enabled: true, rerank: true, version: "v3" },
    filters: {
      spaces: ["research"],
      documentIds: ["experiment-2026-08"],
      metadata: { status: "active" },
    },
    expansion: {
      related: true,
      maxHops: 2,
      sameDocument: true,
      associate: true,
      maxAdded: 30,
    },
    externalRerank: { enabled: true, mode: "rrf", alpha: 0.35 },
    postprocess: {
      timeDecay: true,
      dedupe: true,
      truncate: true,
      minScore: 0.35,
      maxResults: 8,
      maxContentLength: 3000,
    },
  },
});
```

各层职责保持分离：

- `filters` 是硬 scope；向量、BM25、标签扩展、关系扩展、关联候选和最终格式化都
  不能超出它。`spaces: []` 表示明确的空集合。
- `expansion.related` 沿显式/派生关系做有界多跳；`sameDocument` 加入同文件块；
  `associate` 使用标签共现和向量邻居。新增候选会进入同一后处理尾链。
- `expansion.fullDocument` 会把命中块所在文件的正文按 chunk 顺序合并到种子结果；它
  与 `sameDocument` 分开，后者只补同文件兄弟块。
- `externalRerank` 需要通过 `ctx.reranker` 或配置注入函数；`mode: "rrf"` 是
  外部排序与原始排序的 RRF 融合，和 geodesic 不同。RRF 分数会成为后续
  time decay、truncate 和最终输出使用的有效分数。
- `postprocess` 的时间衰减、去重、分数下限、数量和正文长度在最终格式化前执行。

实际阶段顺序是：

```text
scope → vector + BM25 → field/topology → candidate expansion
→ dedupe → external rerank → time decay → truncate
→ final scope → format
```

这样扩展出来的结果不会绕过去重、外部排序、时间衰减、截断或 scope。

## 自动选择如何工作

```ts
const result = await engine.search("这份记忆和上一版方案有什么关联？");
console.log(result.retrievalTrace);
```

画像器只看普通文本，提取关系、顺序、主题、时间、直接证据、实体和概念。默认规则
是：

- “关联、来源、路径、沿着、直接引用”等关系/路径意图提高 `topology`；
- “标签、主题、概念、关键词”等主题意图提高 `field`；
- 没有专门意图时保留 `semantic` 作为稳定默认；
- 时间表达只额外打开 time decay，不会强行把查询变成拓扑查询。

结果中的 `retrievalTrace` 包含 `plan`、`profile`、`decision`、`stageOrder` 和
`fallbacks`。它说明“为什么选择”，但不是通用语言模型：复杂或歧义问题可以用
类型化计划显式指定。应用若已有领域解析器，也可以通过 `queryInterpreter` 提供
额外画像字段；它仍接收普通字符串，不接收查询 MDX。

## 原生能力和安全降级

文件型 SQLite 且可用 Windows/Linux native binding 时，`field`/`topology` 会优先
复用同一个 Memo artifact 和查询 observation。可观察字段包括：

- `nativeMemoSkipped` / `nativeMemoSkipReason`；
- `riverMemo.native`、`riverMemo.algorithmVersion`、`riverMemo.diagnostics`；
- `topologyV3` 的 schema、direct-anchor trace 和候选诊断；
- `geodesic.version`，原生路径为 `rust-dtsc-v1`。

`:memory:` 数据库、缺失 binding 或原生输入不兼容时，field 会尽量回落到 TypeScript
TagMemo；Topology V3 保留已有基础候选并设置明确的 skip 字段。库不会把“阶段已加入”
伪装成“原生算法已执行”。
