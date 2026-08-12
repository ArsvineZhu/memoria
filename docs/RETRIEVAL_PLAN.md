# RetrievalPlan

`RetrievalPlan` 是 `MemoryEngine` 的 typed retrieval contract。输入在构造和查询边界
立即校验未知键、枚举、布尔值、范围和列表类型；不接受旧 strategy、版本选择或开放式
section。

## 顶层结构

```ts
interface RetrievalPlan {
  strategy: "auto" | "semantic" | "associative" | "structural";
  associative?: {
    enabled?: boolean;
    tagBasisProjection?: boolean;
    tagResidualDecomposition?: boolean;
    tagGraphPropagation?: boolean;
    propagationSupport?: boolean;
    embeddingRerank?: boolean;
    nativeTagRetrieval?: boolean;
    tagExpansion?: boolean;
  };
  structural?: {
    enabled?: boolean;
    propagationStructure?: boolean;
    relationExpansion?: boolean;
  };
  propagationHistory?: { enabled?: boolean };
  filters?: {
    spaces?: readonly string[];
    documentIds?: readonly string[];
    recordedAfter?: number | string;
    recordedBefore?: number | string;
    metadata?: Record<string, unknown>;
  };
  externalRerank?: { enabled?: boolean; mode?: "ordered" | "rrf"; alpha?: number };
  expansion?: {
    related?: boolean;
    maxHops?: number;
    sameDocument?: boolean;
    fullDocument?: boolean;
    associate?: boolean;
    maxAdded?: number;
  };
  postprocess?: {
    timeDecay?: boolean;
    dedupe?: boolean;
    truncate?: boolean;
    minScore?: number;
    maxResults?: number;
    maxContentLength?: number;
  };
}
```

## 计划示例

纯语义查询：

```ts
await engine.search("实验记录", { retrievalPlan: { strategy: "semantic" } });
```

标签关联查询：

```ts
await engine.search("相同主题的记录", {
  retrievalPlan: {
    strategy: "associative",
    associative: {
      enabled: true,
      tagBasisProjection: true,
      tagResidualDecomposition: true,
      tagGraphPropagation: true,
      propagationSupport: true,
    },
    propagationHistory: { enabled: true },
  },
});
```

来源、路径和关系查询：

```ts
await engine.search("这两条记录的来源关系", {
  retrievalPlan: {
    strategy: "structural",
    associative: { enabled: true },
    structural: { enabled: true, propagationStructure: true, relationExpansion: true },
    expansion: { related: true, maxHops: 2, maxAdded: 20 },
    postprocess: { dedupe: true, maxResults: 8 },
  },
});
```

`QueryBuilder` 与上述对象走同一个 normalization；`engine.explain()` 可在不执行检索
的情况下查看计划和决策。

## 策略应用

规范化计划映射到 canonical gates：

| 计划区段                                             | 主要开关                            |
| ---------------------------------------------------- | ----------------------------------- |
| `associative.tagBasisProjection`                     | `tagBasisProjectionEnabled`         |
| `associative.tagResidualDecomposition`               | `tagResidualDecompositionEnabled`   |
| `associative.tagGraphPropagation`                    | `tagGraphPropagationEnabled`        |
| `associative.propagationSupport`                     | `propagationSupportRerankEnabled`   |
| `associative.embeddingRerank`                        | `embeddingRerankEnabled`            |
| `associative.nativeTagRetrieval`                     | `nativeTagRetrievalEnabled`         |
| `structural.propagationStructure`                    | `propagationStructureRerankEnabled` |
| `structural.relationExpansion` / `expansion.related` | `relationExpansionEnabled`          |
| `propagationHistory.enabled`                         | `propagationHistoryEnabled`         |

阶段可以因为空候选、空标签图、scope 或依赖不可用而安全跳过；这些字段只保留在内部
pipeline。阶段加入 pipeline 不等于该次查询产生了算法信号，公开结果通过
`retrieval.evidence` 和 `retrieval.fallbacks` 表达。

## Trace invariant

结果的 `retrieval` 包含 `strategy`、`strategySource`、`plan`、`evidence` 和稳定的
`fallbacks` reason；原始 stage 名称不进入 SearchEnvelope，并且 `propagationHistory`
独立于 `associative` 和 `structural` sections。
