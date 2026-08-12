# Tag Residual Decomposition

## 目标

Tag Residual Decomposition 将查询向量中已经由近邻 tag 方向解释的部分与剩余方向分开，为传播和扩展提供可解释的输入。

## 输入与输出

输入：

- 查询向量；
- tag vector search 与 tag lookup 的内部数据；
- \`maxLevels\`、\`topK\`、\`residualStopEnergyRatio\`；
- 可选 native acceleration。

输出 \`tagResidualDecomposition\`：

- \`levels\`：每一层选中的 tag、相似度、贡献、投影幅度和剩余能量；
- \`totalExplainedEnergy\`；
- \`finalResidual\`；
- \`features\`：depth、coverage、novelty、coherence、propagationReadiness、expansionSignal 等诊断。

## 计划与阶段

\`RetrievalPlan.associative.tagResidualDecomposition\` 默认开启，位于 Tag Basis Projection 之后。没有 tag 结果、tag lookup 为空、查询能量接近零或内部搜索失败时，阶段以空/跳过结果结束，不伪造一个有意义的 tag 解释。

## 核心计算

每一层对当前 residual 查询：

1. 搜索当前 residual 的近邻 tags；
2. 读取这些 tags 的向量；
3. 用 Gram-Schmidt/正交投影计算投影和新 residual；
4. 根据原始查询能量记录本层解释比例；
5. 分析 residual directions；
6. 当剩余能量低于 \`residualStopEnergyRatio\` 或达到 \`maxLevels\` 时停止。

可概括为：

\`\`\`text
projection = orthogonalProjection(currentResidual, tagVectors)
nextResidual = currentResidual - projection
levelExplained = max(0, ||currentResidual||² - ||nextResidual||²) / ||originalQuery||²
\`\`\`

这里的 level 是计算轮次，不是用户可见的数据层级。算法不会把剩余向量强行归零，最终的 \`finalResidual\` 仍可用于后续诊断。

## 边界与失败语义

- 向量维度或有限性不正确时抛出数值校验错误。
- tag search 抛错时结束分解并保留已完成的 levels；lookup 为空时同样停止。
- 零向量返回空结果。
- Rust 方法不可用时回退到 TypeScript 算法路径；这不改变公开字段语义。
- 这是分析阶段，不等于 tag expansion，也不直接向结果池添加 chunk。

源码：[tag-residual-decomposition.ts](../../src/algorithms/tag-residual-decomposition.ts)、[stage](../../src/stages/tag-retrieval/tag-residual-decomposition.ts)。
