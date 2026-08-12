# 算法边界

算法源码是内部实现，不从根 runtime export。本文只描述 canonical stage 的输入、输出
和不变量；数值公式、排序和失败语义以 `src/algorithms/`、`src/stages/tag-retrieval/`
及对应测试为准。

## Tag Basis Projection

`tag-basis-projection.ts` 对 tag vectors 构建正交 basis，并为 query/candidate 生成
projection、entropy、dominant axes 和 axis coactivation。native 辅助调用是
`computeTagBasis`、`publishTagBasisCache` 和 `projectTagBasis`；缓存失效由 model、
dimension、generation 和 config signature 决定。

## Tag Residual Decomposition

`tag-residual-decomposition.ts` 从 query vector 逐步解释 tag contribution，输出 levels、
explained energy、final residual 和 direction features。native 辅助调用是
`computeTagResidualMetrics`、`computeResidualDirections`。没有足够 tag vectors 时返回
明确的 skipped/empty data，不伪造 residual result。

## Activation Propagation

`activation-propagation.ts` 从 core tags 和 residual signal 构建 query-side tag association graph，
输出 activations、seed/local/extended distributions、propagation provenance、nodes、edges 和
diagnostics。边界由 `propagationMaxHops`、`routingBudget`、`activationThreshold`、
`maxNeighborsPerNode` 和 `maxPropagationStates` 控制。

## Graph Diffusion

`graph-diffusion-solver.ts` 在同一 operator space 上求 local 与 transfer diffusion，
并输出 local/extended distributions、effective supports、mass 和 convergence diagnostics。
`graph-diffusion.ts` 紧接 activation stage 消费这些结果；没有 propagation output 时
安全跳过。native 辅助调用是 `projectDiffusionDistributions`。

## Propagation History

`propagation-history.ts` 使用 `PropagationHistoryStore` 保存独立于 core plan 的状态：
`sequence`、`edgeTotals`、`spreadClass`、`spreadScore`、`historySupport`、`nodeTotals`
和 `activeEdges`。序列更新是有界的，读取失败会保持可解释的 skip/error 语义。

## Propagation Support

support reranker 对 candidate tag IDs 汇总 activation support，使用
`tag-association-transition-v1` payload 和 `supportScore`、`normalizedSupportScore`、
`finalScore`、`hitCount`。Rust 和 TypeScript 实现共享排序边界；native 结果还带
`algorithmVersion`、`diagnostics` 和 `native` 标记。

## Propagation Structure

structure reranker 消费同一 query observation 和 graph artifact，计算 spread class/score、
structure bonus、propagation bonus、history support 和候选排序。native ABI 是
`rerankByPropagationStructure`，输出 schema 是 `propagation-structure-v1`；TS stage 在
native 不可用时继续执行相同的 deterministic candidate contract。

## Tag Context Fusion

native `fuseTagContext` 按 tag weights 将 tag context 融合回 query vector，并保留
dimension、dedup threshold 和 max tag 边界。它是内部辅助 API，不属于根 runtime export。

## 测试边界

纯算法测试位于 `tests/algorithms/`，stage 组合测试位于 `tests/stages/`，native smoke 和
MemoryEngine 集成测试位于 `tests/core/`、`tests/native/` 和 `tests/integration/`。
`eval/` 是 Git ignored 本地评测资料，不参与源码、文档或术语扫描。
