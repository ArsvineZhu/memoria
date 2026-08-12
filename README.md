# memoria：给 AI 应用使用的持久化记忆库

`memoria` 可以把文字保存下来，并在之后按意思或关键词找回。它同时保存
原文、标签和向量，关闭程序后数据仍可恢复。调用方未指定 `dataPath` 时，库会在
调用方工作目录使用 `data/`；这不是仓库随包的数据。

## 你可以用它做什么

- 用关键词和语义一起搜索，减少“换一种说法就找不到”的情况；
- 自动从文档提取标签，并按标签扩展相关记忆；
- 按需启用 TagBasisProjection、TagResidualDecomposition、TagGraphPropagation、Graph Diffusion、Propagation History、关联候选和多种重排阶段；
- 保存并恢复 SQLite 元数据和向量索引；
- 直接提交一段文字，也可以让文件适配器读取 Markdown/MDX；
- 按需注入实现 OpenAI-compatible embeddings 协议的服务；
- 按需注入 OpenAI-compatible reranker；默认搜索不访问模型服务；
- 用独立的 TDB 引擎保存较稳定的冷知识。

## 最快运行方式：第一个教程

教程会根据 provider 配置自动选择 fake 或 OpenAI-compatible provider；没有完整配置时只
保证流程可运行，不保证召回质量。先在仓库根目录安装依赖：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm build:test
node dist-test/tutorials/01-first-memory/main.js
```

教程会使用仓库提供的 MDX 语料，执行初始化、摄入、搜索、删除和关闭流程，并把
运行时数据库和索引写入对应教程的 `data/runtime/`；源文件不会被覆盖。完整学习路径见
[tutorials/README.md](tutorials/README.md)。

## 最小接入示例

下面的例子展示逻辑接口的调用形状。应用需要自己提供嵌入 Provider；教程中的 fake
provider 只属于教程支持代码，不是库的隐式 fallback。

```ts
import { createMemoryEngine } from "memoria";
import type { EmbeddingProviderContract } from "memoria";

declare const embeddingProvider: EmbeddingProviderContract;

const engine = createMemoryEngine({
  config: {
    dataPath: "./data",
    dimension: 128,
    topK: 3,
  },
  embeddingProvider,
});

async function main(): Promise<void> {
  await engine.initialize();

  await engine.ingest({
    id: "demo:coffee",
    content: "手冲咖啡：水温约 93 度，粉水比 1:15。",
    revision: "1",
    metadata: { topic: "coffee" },
  });

  const result = await engine.search("手冲 萃取参数", { topK: 3 });
  console.log(result.results);

  await engine.remove("demo:coffee");
  await engine.close();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

## 排序和 rerank

搜索默认先将向量检索和 BM25 结果做分数融合、去重和排序。这一步不是模型 rerank。
embedding cosine、传播支持和传播结构是可选的本地重排阶段；它们默认关闭。模型重排
同样默认关闭，只有显式注入 `ExternalReranker` 并开启 `externalRerankEnabled` 才会执行，
位置固定为去重之后、时间衰减和截断之前。

库提供一个不绑定具体服务商的 OpenAI-compatible reranker 适配器，调用方自己提供
endpoint、密钥和模型：

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
  config: {
    externalRerankEnabled: true,
  },
});
```

不配置 `reranker` 或不打开 gate 时，搜索不会发起 reranker 网络请求。

如果应用希望固定一条默认检索策略，可以在构造时配置 typed plan；单条查询仍可覆盖，或
通过不可变的 `engine.query()` 使用链式写法：

```ts
const engine = createMemoryEngine({
  defaultRetrievalPlan: {
    strategy: "associative",
    associative: {
      enabled: true,
      tagGraphPropagation: true,
      propagationSupport: true,
    },
  },
  embeddingProvider,
});

const result = await engine
  .query("实验记录的来源关系")
  .structural()
  .propagationStructure()
  .structuralRelations()
  .postprocess((p) => p.dedupe().limit(8))
  .run();
```

`RetrievalPlanInput`、`SearchOptions` 和 `QueryBuilder` 保持 JSON-like 计划的全部可序列化
能力；Builder 只是生成普通计划并调用同一个 `engine.search()`。默认计划、查询覆盖和自动
决策会出现在结果的 `retrievalTrace` 中。查询文本仍是普通字符串，不解析额外标签语法、
placeholder 或 query MDX。

如果你的数据已经是文件，可以使用 `memoria/adapters/filesystem`。文件适配器负责
扫描、读取和监听文件；`MemoryEngine` 负责实际摄入和检索。推荐的文件位置是
调用方自己管理的 `<dataPath>/content/<分类>/<文件名>.mdx`。

## MDX 文件格式

`.mdx` 文件可以在开头写 YAML front matter。`tags` 会进入标签流程，其他字段会作为
结果中的 metadata；正文才会被分块和嵌入。MDX/JSX 只作为文字读取，不会被执行。

```mdx
---
title: 手冲咖啡
tags:
  - 咖啡
  - 生活记录
recordedAt: 2026-08-08T09:30:00-06:00
source: personal-journal
---

# 正文

今天手冲咖啡：水温约 93 度，粉水比 1:15。
```

文件格式由调用方显式 `format`、文件扩展名或默认值决定：`.mdx` 是 `mdx`，`.md` 是
`markdown`，无扩展名的逻辑文档默认是 `text`。只有 `markdown`/`mdx` 才会解析开头的
YAML front matter 和静态关系；逻辑文档若要使用这些能力，请传入
`format: "mdx"`（或 `"markdown"`）。`format: "text"` 可覆盖文件扩展名，保持正文
完全不解析。只改标题或标签时，系统会尽量复用正文向量，不重复计算正文嵌入。
调用方应自行决定运行时目录的备份和清理策略；仓库中的教程 MDX 只用于教程，不会进入
发布包。

## 使用 provider 配置

复制并编辑 `tutorials/08-provider-selection/.env.example` 到
`tutorials/08-provider-selection/.env`，写入完整的 `EMBED_*` 和/或 `RERANK_*` 配置，
然后运行 provider 选择教程：

```powershell
Copy-Item tutorials/08-provider-selection/.env.example tutorials/08-provider-selection/.env
corepack pnpm tutorial:08
```

也可以直接设置当前 PowerShell 进程的环境变量；进程环境变量优先于 `.env`。没有完整配置
时教程使用 fake，只保证流程可以运行，不保证召回质量。

完整 provider 选择、fake/配置 provider 规则、reranker 配置和失败语义见
[08-provider-selection](tutorials/08-provider-selection/README.md) 及
[算法手册](tutorials/algorithms/README.md)。

## 文档入口

| 需要了解的内容                        | 文档                                                         |
| ------------------------------------- | ------------------------------------------------------------ |
| 所有项目入口和目录边界                | [INDEX.md](INDEX.md)                                         |
| 了解文档体系和阅读路径                | [docs/README.md](docs/README.md)                             |
| 第一次接入                            | [docs/GUIDE.md](docs/GUIDE.md)                               |
| 配置和默认值                          | [docs/CONFIGURATION.md](docs/CONFIGURATION.md)               |
| 公开 API 和类型                       | [docs/API.md](docs/API.md)                                   |
| 检索能力、开关和诊断字段              | [docs/RETRIEVAL_FEATURES.md](docs/RETRIEVAL_FEATURES.md)     |
| 自动选择策略和显式 canonical 检索计划 | [docs/RETRIEVAL_STRATEGIES.md](docs/RETRIEVAL_STRATEGIES.md) |
| 不可变 MDX 文件源和派生关系图         | [docs/RELATIONS.md](docs/RELATIONS.md)                       |
| `RetrievalPlan` 类型化算法计划        | [docs/RETRIEVAL_PLAN.md](docs/RETRIEVAL_PLAN.md)             |
| 架构和生命周期                        | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                 |
| 持久化、恢复和备份                    | [docs/PERSISTENCE.md](docs/PERSISTENCE.md)                   |
| 测试和验证                            | [docs/TESTING.md](docs/TESTING.md)                           |
| 常见故障                              | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)           |
| 全部专题文档                          | [docs/INDEX.md](docs/INDEX.md)                               |
| 参与开发                              | [CONTRIBUTING.md](CONTRIBUTING.md)                           |

## 运行检查

```powershell
corepack pnpm verify:docs
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

provider 集成测试没有完整配置时会明确跳过；这不等同于网络链路已验证。完整检查和 CI
说明见 [docs/TESTING.md](docs/TESTING.md)。

## 许可证

MIT © 2026 Arsvine Zhu
