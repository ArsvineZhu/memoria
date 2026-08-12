# Provider 与注入

## EmbeddingProviderContract

最小 contract：

```ts
interface EmbeddingProviderContract {
  embedBatch(
    texts?: readonly string[],
    options?: EmbeddingOptions,
  ): Promise<(VectorLike | null)[]>;
  embed?(
    text: string,
    options?: EmbeddingOptions,
  ): VectorLike | Promise<VectorLike | null>;
  getDimension(): number;
}
```

库不读取环境变量来构造 provider。调用者创建 provider 后显式传给 createMemoryEngine({ embeddingProvider })。

## ExternalReranker

```ts
const reranker: ExternalReranker = async (query, candidates) => {
  console.log(query, candidates.length);
  return candidates;
};
```

实际 contract 的候选元素是库内部归一化后的 chunk candidate；调用者只需把 provider
实现为接收 query 和只读候选数组、返回同一候选 shape 的数组，不需要导入内部 stage 或
pipeline 类型。

注入方式：

```ts
import { createMemoryEngine } from "memoria";
import { createOpenAICompatibleReranker } from "memoria/providers/openai-compatible";

const engine = createMemoryEngine({
  reranker: createOpenAICompatibleReranker({ apiUrl, apiKey, model }),
  config: { externalRerankEnabled: true },
});
```

适配器不携带 endpoint、key 或 model 默认值。它只实现兼容协议的请求、超时、candidate 限制、JSON score 解析、非法候选过滤和错误分类。

## Fake provider

fake provider 只在教程 _support/ 中使用，不是库 runtime fallback。它用于：

- 让没有密钥的读者跑通生命周期；
- 测试 dimension、batch、排序阶段和错误边界；
- 展示 provider 注入点。

它不能证明语义召回效果。需要质量评测时，应使用完整配置、固定语料、明确的查询集合、相关性标注和独立指标。

## Store injection

metadataStore、vectorStore 和 relation store 是正式 injection contracts。它们必须满足对应 contract 的生命周期、维度和持久化约束；教程不直接构造内部 PipelineContext。
