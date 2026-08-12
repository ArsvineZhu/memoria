# Embedding Reranking

## 目标

Embedding Rerank 使用已有查询向量和候选 chunk 向量做确定性 cosine 重排。它不是外部 reranker provider，也不会因为计划选择该 capability 就访问网络。

## gate 与阶段

\`RetrievalPlan.associative.embeddingRerank\` 默认关闭。它在候选扩展之后执行，通常早于 dedupe。它使用 engine 已注入的 embedding provider 产生查询向量；候选向量来自 vector store/metadata pipeline。

## 输入与输出

输入：

- query vector；
- candidate chunk vectors；
- \`RetrievalPlan.associative.embeddingRerank\`；
- score/weight/cap 相关配置。

输出是重新排序后的 candidates 和 \`embeddingRerank\` diagnostic。候选缺少有效向量时会遵循当前 stage 的跳过/保留语义，不应伪造 cosine 分数。

## 计算解释

对归一化向量计算：

\`\`\`text
cosine(query, candidate) =
dot(query, candidate) / (||query|| × ||candidate||)
\`\`\`

实现对零向量、维度错误和非有限值进行保护，然后将相似度与当前候选分数按配置组合。该阶段不会向任何 HTTP endpoint 发送请求；查询 embedding 是否网络化取决于调用者注入的 embedding provider。

## 与模型重排的区别

- embedding rerank：本地、确定性、输入是向量；
- external rerank：调用者注入 \`ExternalReranker\`，输入是查询和候选文档，可能联网；
- 两者都必须通过各自 plan section 显式开启；
- 默认搜索两者都关闭。

源码：[embedding-reranker.ts](../../src/stages/tag-retrieval/embedding-reranker.ts)。公开用法见 [05-expansion-and-reranking](../05-expansion-and-reranking/README.md)。
