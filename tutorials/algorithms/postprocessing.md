# Postprocessing：Dedupe、Time Decay、Truncate

## 目标

Postprocessing 将候选池变成稳定的公开结果：去除重复、可选地加入时间衰减、应用分数/数量/内容长度限制，并格式化 document/chunk/result 字段。

## Dedupe

\`dedupeEnabled\` 控制结果去重。去重阶段位于扩展和本地算法之后、External Rerank 之前。它优先保留同一逻辑文档/chunk 的代表候选，并可结合 exact/semantic 条件；因此 external reranker 不会对同一内容的重复项重复计分。

## Time Decay

\`timeDecayEnabled\` 打开后，按 recorded time 与 \`timeDecayNow\`、\`timeDecayHalfLife\`、\`timeDecayUpperBound\` 计算时间影响。它位于 External Rerank 之后。没有可用 recorded time 时按 stage 的默认保留语义处理；时间衰减不是删除，也不是永久修改源文档。

## Truncate 与 minScore

\`truncateEnabled\` 打开后，Truncator 应用：

- \`truncateMinScore\`：阶段级最低分；
- \`maxResults\`/相关 topK：结果数量上限；
- \`maxContentLength\`：内容输出长度上限；
- \`truncateEllipsis\`：是否添加省略号。

\`minScore\` 也可能来自 SearchOptions/plan；具体优先级由 query plan normalization 决定。截断只改变当前结果 envelope，不改变 SQLite 源记录和 vector index。

## 阶段顺序

\`\`\`text
Expansion
→ Result Deduplicator
→ External Reranker
→ Time Decay
→ Truncator
→ final filter
→ Result Formatter
\`\`\`

这是库保证的可观察顺序。可以通过 \`retrievalTrace.stageOrder\` 验证：

\`\`\`ts
const result = await engine.search("项目计划", {
retrievalPlan: {
strategy: "auto",
externalRerank: { enabled: true, mode: "ordered" },
postprocess: { timeDecay: true, truncate: true, maxResults: 5 },
},
});
console.log(result.retrievalTrace?.stageOrder);
\`\`\`

## 空输入与失败

- 空候选池返回空结果，不会创建虚构 result。
- 去重后为空是合法情况。
- provider 失败发生在 External Rerank 时应向调用者报告，不由 postprocess 掩盖。
- truncate 不会修复维度错误、schema 错误或 native binary 缺失。
- \`maxContentLength\` 只影响输出内容，不改变原始 MDX。

源码：[result-deduplicator.ts](../../src/stages/postprocess/result-deduplicator.ts)、[external-reranker.ts](../../src/stages/postprocess/external-reranker.ts)、[time-decay.ts](../../src/stages/postprocess/time-decay.ts)、[truncator.ts](../../src/stages/postprocess/truncator.ts)。
