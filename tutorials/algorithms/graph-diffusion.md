# Graph Diffusion

## 目标

Graph Diffusion 使用 Activation Propagation 的输出，在 tag graph 上计算扩散后的分布和结构诊断，用于结构型检索和后续重排。

## 输入与输出

输入：

- propagation 的 node/edge state；
- association graph；
- diffusion solver 配置；
- 查询和 residual 相关信号。

输出会进入公开的 \`tagGraphPropagation\`/结构相关 envelope 字段，具体字段以当前 public declaration 为准；常见诊断包括扩散分布、收敛/迭代状态、spread diagnostics 和失败/跳过标记。

## 计划与顺序

\`RetrievalPlan.associative.tagGraphPropagation\` 同时控制 Activation Propagation 与 Graph Diffusion 的连续组合。流水线必须保持：

\`\`\`text
Activation Propagation → Graph Diffusion
\`\`\`

\`structural\` strategy 会请求结构路径，但是否能产生有效结果还取决于图 artifact 和配置。关闭 plan section、缺少 graph artifact 或没有 propagation state 时，阶段应报告 skipped/empty，而不是伪造结构分数。

## 求解说明

solver 根据图边权、节点状态和配置计算传播分布；实现使用有限迭代、阈值和数值保护，避免在异常图上无限运行。图是有向关系时，方向会影响可达节点和边流；不能把结果解释为无向距离。

应用层不需要调用 solver。通过：

\`\`\`ts
const explanation = await engine.explain("相关主题", {
retrievalPlan: { strategy: "structural" },
});
console.log(explanation.plan);
\`\`\`

可以确认是否走了结构路径。

## 边界

- 没有图数据时，结构检索可能没有额外支持，但基础向量/BM25 仍可返回结果。
- 数值不收敛或 native runtime 失败时，错误语义由当前 stage/runtime 返回；不要在教程中声明“自动切换到另一个 provider”。
- Graph Diffusion 不是 external model rerank，也不产生网络请求。

源码：[graph-diffusion-solver.ts](../../src/algorithms/tag-graph/graph-diffusion-solver.ts)、[graph-diffusion.ts](../../src/stages/tag-retrieval/graph-diffusion.ts)。
