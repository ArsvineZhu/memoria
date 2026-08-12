# Hybrid Search：向量与 BM25

## 目标

Hybrid Search 同时利用语义相似度和词法匹配，得到比单一路径更稳健的候选集合。它不访问 reranker 模型，也不代表已经执行了模型重排。

## 输入与输出

输入是查询文本和 \`SearchOptions\`：

- query：原始查询；
- \`topK\`、\`maxResults\`：候选和最终结果上限；
- \`indexNames\`：要查询的向量索引；
- \`spaces\`、\`filters\`：候选范围；
- embedding provider：把查询转换为与索引一致维度的向量。

中间输出包括 \`vectorResults\`、\`bm25Results\`、\`mergedCandidates\`；这些字段只存在于内部 pipeline。公开的 \`SearchEnvelope\` 只返回最终结果和稳定的 \`retrieval.evidence\`。

## 阶段与计划

阶段顺序是：

\`\`\`text
Query Embedder → Vector Searcher
↘
Candidate Merger
↗
BM25 Searcher
\`\`\`

这部分不依赖 external rerank plan section。只要 engine 初始化成功并且索引可用，默认搜索就能执行；默认不会因为搜索而访问网络。

## 实现解释

向量路径使用查询向量和 chunk 向量计算相似度。BM25 路径使用查询词与索引中的文本字段计算词法相关性。Candidate Merger 将两路候选按配置权重合并，并保留来源诊断。后续阶段可以再做 dedupe、扩展、重排和 postprocess。

不要把 \`vectorWeight\`、\`bm25Weight\` 解读为模型置信度；它们只是候选融合中的确定性权重。空的一路不会让另一路失效，但没有内容或没有可用索引时可能得到空结果。

## 结果与边界

- \`topK\` 控制检索规模，\`maxResults\` 控制结果数量时需结合当前 plan/config 理解。
- \`minScore\` 和 \`maxContentLength\` 属于后处理，不是 BM25 公式的一部分。
- \`spaces\`、metadata 和时间范围过滤可以限制候选；过滤后的空集合是合法结果。
- embedding 维度必须与已建 vector index 一致；不一致应修正 provider/index 配置，而不是依赖 fake fallback。
- fake embedding 只保证教程流程可运行，不保证语义召回质量。

## 可运行观察

\`\`\`ts
const envelope = await engine.search("整理旅行计划", {
topK: 10,
spaces: ["travel"],
indexNames: ["tag_vectors"],
});
console.log(envelope.results.length, envelope.retrieval?.evidence);
\`\`\`

源码位置：[vector-searcher.ts](../../src/stages/retrieval/vector-searcher.ts)、[bm25-searcher.ts](../../src/stages/retrieval/bm25-searcher.ts)、[candidate-merger.ts](../../src/stages/retrieval/candidate-merger.ts)。
