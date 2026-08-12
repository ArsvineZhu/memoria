# External / Model Reranking

## 目标

External Rerank 在候选去重之后调用调用者注入的 \`ExternalReranker\`，按 provider 返回的分数重排。库提供 OpenAI-compatible 协议适配器，但不提供厂商默认配置。

## 计划、注入与阶段

必须同时满足：

1. \`MemoryEngineOptions.reranker\` 已注入；
2. 当前 retrieval plan 的 \`externalRerank.enabled: true\`；
3. 当前 plan 没有明确关闭该阶段。

位置固定为：

\`\`\`text
candidate retrieval
→ expansion / local stages
→ dedupe
→ External Rerank
→ Time Decay
→ Truncate
→ result format
\`\`\`

\`\`ExternalReranker\`\` 可能联网，因此默认搜索不会触发它。

## ordered 与 RRF

\`externalRerankMode: "ordered"\` 使用 provider 返回的有效候选顺序/分数作为主排序信号。\`"rrf"\` 使用外部排名与内部排名进行 reciprocal-rank fusion；\`externalRerankAlpha\` 控制融合偏向。无效候选、重复候选和越界 score 会按 provider/stage contract 过滤或报错。

## 失败语义

- 没有 provider：plan 开启时应得到明确的配置错误，而不是隐式 fake；
- HTTP 错误、超时、非法 JSON、空响应或非法 score：由 provider 归类并向调用者报告；
- provider 已开始 HTTP 请求后失败，绝不切换到 fake；
- fake reranker 只能保证 tutorial 生命周期和输出形状，不能证明排序效果；
- 后续 Time Decay、Truncate 仍可能改变最终显示顺序/数量，但不会绕过 External Rerank 阶段。

## 公开用法

\`\`\`ts
import { createMemoryEngine } from "memoria";
import { createOpenAICompatibleReranker } from "memoria/providers/openai-compatible";

const engine = createMemoryEngine({
reranker: createOpenAICompatibleReranker({
apiUrl: process.env.RERANK_API_URL!,
apiKey: process.env.RERANK_API_KEY!,
model: process.env.RERANK_MODEL!,
}),
defaultRetrievalPlan: {
strategy: "semantic",
externalRerank: { enabled: true, mode: "ordered" },
},
});
\`\`\`

源码：[external-reranker.ts](../../src/stages/postprocess/external-reranker.ts)、[openai-compatible-reranker.ts](../../src/providers/openai-compatible-reranker.ts)。
