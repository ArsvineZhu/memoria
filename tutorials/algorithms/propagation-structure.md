# Propagation Structure Rerank

## 目标

Propagation Structure Rerank 使用图的节点/边结构和传播诊断，对候选进行确定性结构重排。它属于本地算法，不是 reranker 模型。

## 输入与输出

输入：

- candidate pool；
- association graph 的 node/edge graph score；
- propagation/structure observation；
- \`RetrievalPlan.structural.propagationStructure\`；
- structure bonus cap、sparse threshold、spread/association 相关配置。

输出：

- structure-adjusted candidate score；
- \`propagationStructure\` 和 \`spreadClass\` 等 diagnostics；
- native 或 TypeScript 执行路径的标记（如果当前 envelope 提供）。

## 阶段与策略

本阶段通常由 \`structural\` retrieval strategy 或 plan section 激活，位于 propagation/history 相关阶段之后。它必须在 dedupe 前完成，这样 duplicate candidate 的结构分数不会被重复计入；随后仍要经过 common postprocess tail。

示例：

\`\`\`ts
const result = await engine.search("图结构相关主题", {
retrievalPlan: { strategy: "structural" },
});
console.log(result.results.map((item) => item.chunk?.chunkId));
\`\`\`

## 计算语义

实现会将关联图中的 node/edge 分数和候选关联可靠性组合，在配置的 bonus cap 内调整 semantic base。它还会产生 atomic/positional/narrative 等结构观察字段（字段名称以当前 public declaration 为准）。分数被限制在实现允许的范围内，避免结构 bonus 无限放大基础排序。

## 边界

- 没有 graph artifact、没有传播结果或 plan section 关闭时，结构重排可能跳过。
- 结构分数只在同一配置和同一查询上下文中有意义。
- native 与 JS 路径应保持结果语义；native binary 缺失时是否可 fallback 由当前 backend resolution 决定，不应在应用层自行调用内部 native API。

源码：[propagation-structure-reranker.ts](../../src/stages/tag-retrieval/propagation-structure-reranker.ts)、[activation-propagation.ts](../../src/algorithms/tag-graph/activation-propagation.ts)。
