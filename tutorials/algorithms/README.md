# 算法手册

本目录解释检索流水线中每个可观察阶段的输入、输出、开关、边界和实现位置。它是实现说明，不是内部类的使用入口：应用代码仍应从 \`@arsvinezhu/memoria\` 根导出和正式 subpath 使用能力。

## 阅读顺序

1. [Hybrid Search](./hybrid-search.md)：向量与 BM25 的基础候选集合。
2. [Tag Basis Projection](./tag-basis-projection.md) 与 [Tag Residual Decomposition](./tag-residual-decomposition.md)：查询向量的 tag 结构分析。
3. [Activation Propagation](./activation-propagation.md)、[Graph Diffusion](./graph-diffusion.md) 和 [Propagation History](./propagation-history.md)：图上的传播及其记录。
4. [Propagation Support](./propagation-support.md)、[Propagation Structure](./propagation-structure.md) 和 [Embedding Reranking](./embedding-reranking.md)：确定性重排。
5. [Expansion](./expansion.md)：tag、relation 和同文档扩展。
6. [External Reranking](./external-reranking.md) 与 [Postprocessing](./postprocessing.md)：模型重排、时间衰减、截断和结果格式化。

## 阶段顺序

默认流水线按下面的依赖关系组织。某些阶段由 retrieval plan 控制，关闭时不会产生对应诊断字段；基础向量/BM25 检索仍可单独运行。

\`\`\`text
query embedding
→ vector search + BM25 search
→ candidate merge
→ Tag Basis Projection
→ Tag Residual Decomposition
→ Activation Propagation
→ Graph Diffusion
→ Propagation History
→ local expansion / deterministic reranking
→ dedupe
→ External Rerank
→ Time Decay
→ Truncate
→ result format
\`\`\`

\`Activation Propagation\` 与 \`Graph Diffusion\` 是连续阶段：前者生成图上的传播状态，后者使用这些状态进行扩散计算。不要把两者理解为可交换的同义步骤。

## 共通说明

- plan selection 以 [tutorials/reference/retrieval-plan.md](../reference/retrieval-plan.md) 为准；运行参数默认值以源码 \`src/config/default-config.ts\` 为准。
- 算法阶段是库内部实现，教程只通过 \`MemoryEngine.search()\`、\`MemoryEngine.explain()\`、\`QueryBuilder\` 和公开结果字段观察它们。
- 空输入、维度不一致、缺少 derived artifact、provider 失败等情况不会被 fake provider 自动掩盖；请看各章节的失败语义。
- “重排”在本文中分为确定性本地重排和调用者注入的 external/model rerank；基础排序本身不等于模型重排。

## 相关章节

- [检索计划参考](../reference/retrieval-plan.md)
- [公共 API 参考](../reference/public-api.md)
- [05-expansion-and-reranking](../05-expansion-and-reranking/README.md)
