# Tag Basis Projection

## 目标

Tag Basis Projection 分析查询向量在已建立 tag basis 上的投影集中程度，用于产生后续 tag 检索和诊断所需的结构信号。它不是最终结果排序器。

## 输入与输出

输入：

- 查询向量；
- 已构建的正交 tag basis；
- basis mean；
- 可选的 basis labels 和 energies；
- 与索引一致的向量维度。

输出字段位于 \`tagBasisProjection\`：

- \`projections\`：查询中心化向量在每个 basis 轴上的投影；
- \`probabilities\`：各轴平方投影占总投影能量的比例；
- \`entropy\`：归一化投影熵；
- \`projectionConcentration\`：\`1 - entropy\`；
- \`dominantAxes\`：能量超过阈值的主轴及其 label、energy、projection。

## 计划与阶段

\`RetrievalPlan.associative.tagBasisProjection\` 默认开启。阶段位于 candidate merge 之后、tag residual decomposition 之前。关闭或 basis 不完整时，结果会标记 skipped 或返回空的结构分析，基础检索不会因此自动变成网络调用。

## 核心计算

算法先计算：

\`\`\`text
centeredQuery = queryVector - basisMean
projection[k] = dot(centeredQuery, orthoBasis[k])
\`\`\`

然后用平方投影归一化成能量概率：

\`\`\`text
p[k] = projection[k]^2 / Σ projection[j]^2
entropy = -Σ p[k] log2(p[k])
projectionConcentration = 1 - entropy / log2(K)
\`\`\`

当总能量接近零时返回空结果，避免对零向量做无意义归一化。实现会校验向量维度和有限数值；Rust 加速不可用时使用 TypeScript 计算路径。

## 诊断与边界

- basis mean 或 basis vector 维度不匹配是实现错误或 artifact 不一致，应修复持久化/重建流程。
- \`dominantAxes\` 不是标签结果清单；它只描述 basis 轴。
- 多轴共同激活可形成 \`coactiveAxisPairs\` 诊断，但不会直接替换基础候选分数。
- 没有 basis artifact 时，后续依赖 tag 分析的阶段可能跳过；向量/BM25 基础路径仍可独立观察。

## 公开 API 观察方式

\`\`\`ts
const explanation = await engine.explain("学习索引", {
retrievalPlan: { strategy: "associative" },
});
console.log(explanation.plan);
\`\`\`

应用不应直接实例化内部 \`TagBasisProjection\`。源码：[tag-basis-projection.ts](../../src/algorithms/tag-basis-projection.ts)、[stage](../../src/stages/tag-retrieval/tag-basis-projection.ts)。
