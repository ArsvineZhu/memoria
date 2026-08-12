# 检索策略

`MemoryEngine` 的策略固定为 `auto`、`semantic`、`associative` 和 `structural`。
策略只描述本次查询启用的 canonical retrieval sections；它不携带算法版本，也不读取
外部参数文件。

## 选择规则

| 策略          | 适合的问题                         | 默认启用的方向                                           |
| ------------- | ---------------------------------- | -------------------------------------------------------- |
| `semantic`    | 直接按语义找相似内容               | vector + BM25 hybrid                                     |
| `associative` | 主题、标签、概念和相关记忆         | basis、residual、activation propagation、support         |
| `structural`  | 来源、路径、关系和直接证据         | associative 基础 + structure rerank + relation expansion |
| `auto`        | 让 planner 根据 query profile 选择 | `semantic`、`associative`、`structural` 三者择一         |

显式策略优先于自动决策：

```ts
const semantic = await engine.query("一句事实").semantic().run();
const associative = await engine
  .query("同主题的记忆")
  .associative()
  .activationPropagation()
  .graphDiffusion()
  .propagationSupport()
  .run();
const structural = await engine
  .query("记录之间的来源关系")
  .structural()
  .propagationStructure()
  .structuralRelations()
  .run();
```

## 自动 planner

planner 会为 `semantic`、`associative` 和 `structural` 计算 canonical score，并在
`RetrievalExplanation` 和公开 `retrieval.strategy`/`retrieval.plan` 中返回稳定结果。
`GraphReadiness` 使用 `tagGraphArtifactReady` 表示图资产状态；结构策略要求图资产和
scope 等必要条件准备好，否则决策会选择可执行策略并保留明确原因。

这不是旧 API 兼容行为：不认识的策略、section 或 key 会在 normalization 边界直接
抛出 `TypeError`。

## 阶段顺序

canonical tag-retrieval 链按连续阶段组织：

```text
tag basis projection
  → tag residual decomposition
  → activation propagation
  → graph diffusion
  → propagation history
  → propagation support rerank
  → propagation structure rerank
```

是否加入每个阶段由 plan 和 config gate 共同决定。native runtime 可复用同一查询观测，
但 native 失败时内部保留具体 failure，公开结果只报告稳定的 `retrieval.fallbacks`，
不会伪造成功结果。TS 阶段保留相同的排序、边界和失败语义。

## 与后处理的组合

`filters` 在候选范围边界生效；`expansion` 在去重前增加同文档、关系或关联候选；
`externalRerank` 只在显式配置 provider 时调用；`postprocess` 负责 time decay、dedupe、
truncate、结果上限和正文长度。每个阶段的实际执行情况应从结果 trace 读取。

## scope 和 spaces

文件身份统一使用 `space`。查询用 `filters.spaces` 或 `SearchOptions.spaces` 限制范围，
metadata store 用 `getDistinctSpaces()` 提供可选空间列表。空 scope 是明确的权限/范围
状态，不会被解释成“搜索全部空间”。
