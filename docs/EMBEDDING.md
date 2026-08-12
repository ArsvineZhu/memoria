# EMBEDDING — 嵌入 Provider 体系

本文描述 `EmbeddingProvider` 契约、OpenAI-compatible HTTP provider、OpenAI-compatible
reranker 和教程 fake
provider。实现、字段和默认值以 `src/interfaces/embedding-provider.ts`、
`src/providers/openai-compatible-embedding-provider.ts`、
`tutorials/_support/fake-embedding.ts` 与调用阶段源码为准。

## 1. 接口契约

```ts
class EmbeddingProvider {
  async embedBatch(texts); // Promise<(Float32Array|null)[]>，长度等于输入
  async embed(text); // 基类默认实现：embedBatch([text])[0] || null
  getDimension(); // number
}
```

- `embedBatch` 必须返回与输入同长度的数组；单条失败必须补 `null`。
- `embed(text)` 是基类提供的便捷实现，provider 可以直接继承。
- 库内部只依赖 `embedBatch` 和 `getDimension`。
- provider 配置通过构造器传入，不从 `process.env` 读取。

## 2. 当前实现

| 实现                  | 源码                                                                                                      | 协议/网络                                                                 | 默认维度 |
| --------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------: |
| OpenAI-compatible     | `src/providers/openai-compatible-embedding-provider.ts`，公共子路径 `memoria/providers/openai-compatible` | `POST {apiUrl}/v1/embeddings`，请求体 `{ model, input }`，Bearer `apiKey` |   `1024` |
| FakeEmbeddingProvider | `tutorials/_support/fake-embedding.ts`                                                                    | 无网络，确定性输出                                                        |    `128` |

OpenAI-compatible provider 不绑定具体服务商、endpoint、模型或密钥。`apiUrl`、
`apiKey`、`model` 和 `dimension` 应由调用方显式配置；库的默认配置对 endpoint、
密钥和模型保持空值。provider 支持 `fallbackModels`、按 token/条数分批和有限的
候选模型重试；超大文本或失败批次按输入位置返回 `null`。

## 3. document/query 调用语义

摄入和检索阶段都通过同一个 `embedBatch` 契约：

| 调用位置   | 调用方式                                                                               |
| ---------- | -------------------------------------------------------------------------------------- |
| chunk 嵌入 | `src/stages/ingestion/chunk-embedder.ts` 的 `embedBatch(chunks)`                       |
| tag 嵌入   | `src/stages/ingestion/tag-embedder.ts` 的 `embedBatch(tags)`                           |
| query 嵌入 | `src/stages/retrieval/query-embedder.ts` 的 `embedBatch(texts, { textType: "query" })` |
| TDB        | `src/tdb/tdb-engine.ts` 的 batch/query 调用                                            |

当前 OpenAI-compatible 和 Fake 实现不消费第二个 options 参数，但 query 阶段仍保留
`textType: "query"` 的语义标记，便于未来实现需要区分 query/document 的兼容服务。

## 4. 维度一致性

`embeddingProvider.getDimension()` 必须与 `config.dimension` 相等。向量索引和 SQLite
向量字段都按 `config.dimension` 建立；维度改变时，必须使用新的 `dbPath` 和
`storePath`，重新摄入全部文档。旧数据库、旧索引和 derived artifacts 不迁移。

默认 provider 的装配形状如下：

```ts
new OpenAICompatibleEmbeddingProvider({
  apiUrl: config.apiUrl,
  apiKey: config.apiKey,
  model: config.model,
  modelSig: config.modelSig,
  dimension: config.dimension,
  maxBatchItems: config.maxBatchItems,
  maxToken: config.maxToken,
  concurrency: config.concurrency,
  fallbackModels: config.fallbackModels,
});
```

## 5. 使用方式

通过公共子路径使用兼容 provider：

```ts
import CompatibleEmbeddingProvider from "memoria/providers/openai-compatible";

const embeddingProvider = new CompatibleEmbeddingProvider({
  apiUrl: "https://provider.example",
  apiKey: "your-api-key",
  model: "embedding-model",
  dimension: 1024,
});
```

再将它注入 `createMemoryEngine({ embeddingProvider, config: { dimension: 1024 } })`。
教程中的 `FakeEmbeddingProvider` 只用于保证流程可运行，不属于库的公开 runtime export。

## 6. OpenAI-compatible reranker

库也提供供应商中立的 OpenAI-compatible reranker 适配器。它不读取环境变量，也不
提供 endpoint、密钥或模型默认值；调用方必须显式传入配置，并将返回的
`ExternalReranker` 注入 `MemoryEngineOptions`：

```ts
import { createMemoryEngine } from "memoria";
import { createOpenAICompatibleReranker } from "memoria/providers/openai-compatible";

const engine = createMemoryEngine({
  embeddingProvider,
  reranker: createOpenAICompatibleReranker({
    apiUrl: "https://provider.example/v1/chat/completions",
    apiKey: "your-api-key",
    model: "reranker-model",
  }),
  defaultRetrievalPlan: {
    strategy: "semantic",
    externalRerank: { enabled: true },
  },
});
```

默认搜索不会请求 reranker。适配器发送候选的 `chunkId`、path、title、tags 和截断正文，
并读取 `choices[0].message.content` 中的 JSON score 数组；调用顺序和失败语义见
[检索能力矩阵](RETRIEVAL_FEATURES.md)。

## 7. 已知限制

- 网络 provider 只实现静态 Bearer `apiKey`，没有 OAuth 或服务商专属签名流程。
- 当前 fetch 请求没有独立的 AbortController 超时；429 会按 fallback model 顺序退避。
- 网络 provider 返回 `number[]`，下游会按配置维度写入/校验向量。
- provider 失败位置返回 `null`；摄入阶段过滤失败向量，query 阶段在没有成功向量时
  将查询标记为 failed。
- 缺少 `apiUrl`、`apiKey` 或 `model` 时，调用方必须在初始化前完成配置；provider selection
  example 会在创建数据库前明确报错。
