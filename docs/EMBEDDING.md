# EMBEDDING — 嵌入 Provider 体系

> 本文描述 memoria 的嵌入层：`EmbeddingProvider` 接口契约、三种实现（DashScope
> 原生 / OpenAI 兼容 / 离线 Fake）的逐项对比、document/query 双模式语义、维度
> 一致性规则与 Provider 切换流程。所有字段、默认值与行为以
> `src/interfaces/embedding-provider.ts`、`src/providers/*` 与
> `src/stages/retrieval/query-embedder.ts` 源码为准；发布运行时对应 `dist/`。

## 1. 接口契约（src/interfaces/embedding-provider.ts）

```ts
class EmbeddingProvider {
  async embedBatch(texts); // → Promise<(Float32Array|null)[]>，长度 === texts.length，失败位 null
  async embed(text); // 基类默认实现：embedBatch([text])[0] || null
  getDimension(); // → number
}
```

- **返回对齐**：`embedBatch` 必须返回与输入同长度的数组；单条失败的
  位置必须补 `null`（不能抛错、不能缺位）。
- `embed(text)` 是基类提供的便捷默认实现，子类可不重写。
- 全库调用方只依赖 `embedBatch` 与 `getDimension`（见 §3 调用位置）。

## 2. 三实现对比表

| 属性      | DashScope 原生                                                                            | OpenAI 兼容                                                             | FakeEmbeddingProvider             |
| --------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------- |
| 源码      | `src/providers/dashscope-embedding-provider.ts`                                           | `src/providers/openai-embedding-provider.ts`                            | `examples/demo/fake-embedding.ts` |
| 协议端点  | DashScope 嵌入接口；`config.apiUrl` 可覆盖                                                | `{config.apiUrl}/v1/embeddings`                                         | 无网络                            |
| 请求体    | `{ model, input: { texts }, parameters: { dimension, output_type: 'dense', text_type } }` | `{ model, input: [...texts] }`                                          | —                                 |
| 默认模型  | `qwen3.7-text-embedding`                                                                  | 无内置默认；引擎使用 `config.model`                                     | `fakeEmbeddingProvider`           |
| 默认维度  | `1024`；可由 `config.dimension` 覆盖                                                      | 类默认 `1024`；引擎装配显式传入 `config.dimension`（默认 `3072`）       | `128`；构造时可覆盖               |
| 分批上限  | `maxBatchItems` 默认 `20`；服务端单批最多 20 条                                           | `maxBatchItems` 默认 `32`，并按 token 动态分桶；超限文本跳过并置 `null` | 无网络批处理                      |
| 并发      | 默认 5 个 worker                                                                          | 默认 5 个 worker                                                        | 单线程                            |
| 超时/重试 | `timeoutMs` 默认 `60000`ms；无重试；失败返回 `null`                                       | 无请求超时；429 和其他错误按候选模型重试                                | 永不失败（null 输入返回 null）    |
| key 来源  | `config.apiKey`（Bearer）                                                                 | `config.apiKey`（Bearer）                                               | 无                                |
| 返回类型  | `Float32Array`；维度不符返回 `null`                                                       | `number[]`；Provider 本身不做维度校验                                   | `Float32Array`                    |
| 离线可用  | 否                                                                                        | 否                                                                      | 是（确定性、无需 key）            |

共同点：都收取 `concurrency`（默认 5）；失败位均以 null 补齐，保证
`embedBatch` 返回长度始终等于输入长度；都不读取 `process.env`
（全部配置走构造器）。

## 3. document / query 双模式

查检索侧与索引侧来源调用：

| 调用位置        | 代码                                                                                     | text_type 语义                                         |
| --------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 入库 chunk 嵌入 | `src/stages/ingestion/chunk-embedder.ts:22` — `embedBatch(chunks)`                       | 无 options → DashScope 使用默认 `textType: 'document'` |
| 入库 tag 嵌入   | `src/stages/ingestion/tag-embedder.ts:22` — `embedBatch(tags)`                           | 同上（默认 document）                                  |
| 检索 query 嵌入 | `src/stages/retrieval/query-embedder.ts:71` — `embedBatch(texts, { textType: 'query' })` | **显式传 `textType: 'query'`**                         |
| TDB 冷知识库    | `src/tdb/tdb-engine.ts:244/380` — `embedBatch(batch)` / `embedBatch([qText])`            | 无 options（默认 document）                            |

- DashScope 为不对称检索语义：入库用 `document`、检索用 `query`（源码注释
  建议区分）。`textType` 可在 `config` 中设默认（`textType === 'query'` 时
  默认切 query，否则 document），每次调用亦可用 `options.textType` 覆盖。
- **OpenAI 与 Fake 实现忽略第二个 options 参数**（embedBatch 签名只有
  texts），即只有 DashScope 真正消费 `{textType}`。

## 4. 维度一致性规则

- `getDimension()` 与 `config.dimension` 必须相等：引擎装配
  （`src/engine.ts`）固定以 `dimension: this.config.dimension` 构建默认
  OpenAI Provider；`config.dimension` 默认 3072（default-config.ts:39）。
- 向量索引（Rust）与元数据存储按 config.dimension 建立，SQLite 侧对
  BLOB 长度严格校验（`decodeVectorBlob` 字节数 ≠ dimension×4 → null）。
- DashScope 对服务端返回做校验：长度 ≠ provider.dimension → 整条置 null
  （警告 "Dimension mismatch"）。

```ts
// 引擎装配（src/engine.ts:89-99）—— 维度默认锁在 config.dimension
new OpenAIEmbeddingProvider({
  apiUrl,
  apiKey,
  model,
  modelSig,
  dimension: config.dimension, // 默认 3072
  maxBatchItems,
  maxToken,
  concurrency,
  fallbackModels,
});
```

## 5. 切换 Provider 与迁移库

1. 构造实例：`new DashScopeEmbeddingProvider({ apiUrl, apiKey, model, dimension })`（或 fake）。
2. 注入引擎：`createMemoryEngine({ embeddingProvider: myProvider, config: { dimension: <相同值> } })`。
3. **维度不可变**：已有向量的 BLOB 长度与 VEXUS 索引维度在创建时固定。
   更换维度 = 旧库全部失效，**必须重灌**（确认备份后删除现有
   `storePath`/`dbPath`，再重新 `flush`）；若前后维度相同（如两个 1024 的
   商用模型互切），可复用旧库——但嵌入分布变化递归序，是否重灌视效果。
4. 临时试验：注入 `fakeEmbeddingProvider`（128 维）验证管线流程，不回
   生产（维度与真实模型不同）。

## 6. 诚实的当前限制（均可源码验证）

- **无 OAuth2 / AK-SK 签名**：两个网络实现都只支持静态 Bearer `apiKey`；
  `src/` 全树无 `oauth` / `proxy` 相关代码与 `process.env` 读取。
- **OpenAI 兼容层无超时**：fetch 无 AbortController，慢端点可能挂起
  请求（429 有退避，但网络级停顿未处理）。
- **OpenAI 返回 `number[]`**：契约标注 `Float32Array|null`，实际为
  `number[]|null`；不使用为 Float32Array，代码依赖将向量转 Float32Array
  的只在 Fake/DashScope 路径验证过。
- **OpenAI 不做维度校验**：模型返回任意维度都能入库，传入下游
  decode/encode 可能 BLOB 长度不匹配告警。
- **DashScope 的 `maxToken` 未参与分桶**：构造项存在（默认 64000），
  但 `embedBatch` 不按 token 切批（仅按条数 20）；超长文本直接由服务端
  拒绝、返回 null（不等对 OpenAI 的本地 token 预检）。
- **嵌入失败不抛错**：失败位全部静默置 `null`；入库侧 chunk/tag 过滤掉，
  查询侧 `queries` 为空时置 `failed: true`（query-embedder 判定）。
  一批全部失败无异常，仅服务端 warning 日志。

验证视角：§2/§3 的调用点、构造函数默认值均与源码逐项对照；行为验证见
`tests/providers/`（批次对齐、失败补 null）与 `tests/pipelines/`（query
模式与维度一致性）。
