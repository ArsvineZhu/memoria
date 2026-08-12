# Activation Propagation

## 目标

Activation Propagation 在 tag association graph 上传播由查询得到的 seed activation，让相邻 tag 获得与路径、边权和 hop 相关的传播支持。

## 输入与输出

输入由内部 runtime 提供：

- seed tags 与 activation；
- 有向邻接图或 association edges；
- residual signal；
- \`propagationMaxHops\`、\`activationThreshold\`、\`baseDecay\`、\`maxNeighborsPerNode\` 等配置。

输出包括：

- node activation；
- edge flow；
- provenance/path information；
- \`ActivationDiagnostics\`，包括 reached nodes、active edges、pruned nodes、state truncations、hop mass 和算法版本。

## gate 与连续阶段

\`tagGraphPropagationEnabled\` 控制本阶段，默认关闭。它发生在 Tag Residual Decomposition 之后，并且必须紧接 [Graph Diffusion](./graph-diffusion.md)。如果 propagation 没有执行，diffusion 也不会凭空创建传播输入。

## 核心计算

实现将 activation state 放入图中传播：

- 每个 state 记录 node、previous node、activation、routing budget、source type 和 hop；
- 边权影响流量；
- hop 会带来衰减；
- routing budget、activation threshold、branch limit 和 state 上限用于控制扩散规模；
- 可选 shortcut edge 以不同成本参与；
- 节点读出使用 hop 加权的 FIR 累积。

因此同一个 tag 的支持不只取决于是否相邻，还取决于它从哪些 seed 到达、经过多少 hop、沿途边权和是否被裁剪。空 graph、无 seed 或全部低于阈值时输出空传播结果。

## 失败与边界

- 数值非法或图输入结构不符合 contract 时由算法校验拒绝。
- 达到 \`maxPropagationStates\` 会记录 truncation，而不是无限扩张。
- 图传播不会直接替代 vector/BM25 结果；它通过后续 tag retrieval/rerank 阶段影响候选。
- 传播结果是一次查询的内存状态；是否持久化由 Propagation History gate 决定。

源码：[activation-propagation.ts](../../src/algorithms/tag-graph/activation-propagation.ts)、[stage](../../src/stages/tag-retrieval/activation-propagation.ts)。
