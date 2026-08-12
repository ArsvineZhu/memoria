# RetrievalPlan 参考

## 顶层结构

```ts
interface RetrievalPlan {
  strategy: "auto" | "semantic" | "associative" | "structural";
  associative?: AssociativeSection;
  structural?: StructuralSection;
  propagationHistory?: { enabled?: boolean };
  filters?: FilterSection;
  externalRerank?: ExternalRerankSection;
  expansion?: ExpansionSection;
  postprocess?: PostprocessSection;
}
```

RetrievalPlanInput 允许省略 strategy，规范化后才得到完整 plan。未知 section 和未知字段都会失败。

## Sections

associative 包含 tag basis、residual、graph propagation、support、embedding rerank、native tag retrieval 和 tag expansion。structural 包含 propagation structure 和 relation expansion。

filters 支持 spaces、documentIds、recordedAfter、recordedBefore 和 metadata。externalRerank 支持 enabled、mode: ordered | rrf 和 alpha。expansion 支持 related、sameDocument、fullDocument、associate、maxHops 和 maxAdded。postprocess 支持 time decay、dedupe、truncate、minScore、maxResults 和 maxContentLength。

## Defaults

engine 可以通过 defaultRetrievalPlan 设置固定默认值；单次搜索通过 SearchOptions.retrievalPlan 覆盖。inheritRetrievalDefaults 控制是否继承默认 plan。QueryBuilder 的 withoutDefaults() 和 withDefaults() 是同一语义的链式入口。

## Explain 与 trace

engine.explain(query, options) 只解析 profile、readiness、strategy 和 plan，不执行完整检索。search() 返回的 envelope 可包含稳定的 `retrieval` 诊断：`strategy`、`strategySource`、规范化 `plan`、证据 channel 和 capability fallback。内部 stage 名称与原始 trace 不属于公开结果契约。

## Chain equivalence

下面两种写法在显式关闭默认继承且字段等价时表达同一个 plan：

```ts
engine.search(query, { retrievalPlan: { strategy: "semantic" } });

engine.query(query).withoutDefaults().semantic().run();
```

复杂 plan 应使用 toPlan() 与 object-style plan 做归一化比较，而不是比较 builder 对象身份。
