# memoria：给 AI 应用使用的持久化记忆库

`memoria` 可以把文字保存下来，并在之后按意思或关键词找回。它同时保存
原文、标签和向量，关闭程序后数据仍可恢复。默认数据放在项目的 `data/` 目录，
源文件和运行状态分开管理。

## 你可以用它做什么

- 用关键词和语义一起搜索，减少“换一种说法就找不到”的情况；
- 自动从文档提取标签，并按标签扩展相关记忆；
- 按需启用 EPA、residual pyramid、TagMemo、RiverMemo、关联候选和多种重排阶段；
- 保存并恢复 SQLite 元数据和向量索引；
- 直接提交一段文字，也可以让文件适配器读取 Markdown/MDX；
- 按需使用 DashScope、OpenAI 兼容接口或离线的确定性嵌入；
- 用独立的 TDB 引擎保存较稳定的冷知识。

## 最快运行方式：离线演示

离线演示不需要网络和 API 密钥。先在仓库根目录安装依赖：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm build:test
node dist-test/examples/demo/main.js
```

演示会按固定清单读取 `data/content/` 中的三篇 MDX 文件，执行初始化、摄入、搜索、
删除和关闭流程，并把演示用的数据库和索引写入 `data/memoria/demo/`；不会把同目录
下的 `recall-demo/` 语料摄入。源文件不会被覆盖。详细说明见
[examples/demo/README.md](examples/demo/README.md)。

## 最小接入示例

下面的例子展示逻辑接口的调用形状。它需要应用自己提供一个嵌入 Provider；仓库自带
的离线 Provider 只用于 [离线演示](examples/demo/README.md)，不是主包的公开导出。

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

如果应用希望固定一条默认检索策略，可以在构造时配置 typed plan；单条查询仍可覆盖，或
通过不可变的 `engine.query()` 使用链式写法：

```ts
const engine = createMemoryEngine({
  defaultRetrievalPlan: {
    strategy: "field",
    tagMemo: { plus: true, version: "v10" },
  },
  embeddingProvider,
});

const result = await engine
  .query("实验记录的来源关系")
  .riverMemoRerankPlus({ alpha: 0.35 })
  .expand((e) => e.related({ maxHops: 2 }).fullDocument())
  .postprocess((p) => p.dedupe().limit(8))
  .run();
```

`RetrievalPlanInput`、`SearchOptions` 和 `QueryBuilder` 保持 JSON-like 计划的全部可序列化
能力；Builder 只是生成普通计划并调用同一个 `engine.search()`。默认计划、查询覆盖和自动
决策会出现在结果的 `retrievalTrace` 中。查询文本仍是普通字符串，不解析 VCP 标签、
placeholder 或 query MDX。

如果你的数据已经是文件，可以使用 `memoria/adapters/filesystem`。文件适配器负责
扫描、读取和监听文件；`MemoryEngine` 负责实际摄入和检索。推荐的文件位置是
`data/content/<分类>/<文件名>.mdx`。

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
数据目录的备份和清理规则见
[data/README.md](data/README.md)。

## 使用真实嵌入

真实嵌入是可选的。把 `EMBED_API_KEY=...` 写入
`examples/real-embed/.env`，然后运行 50 文件召回演示：

```powershell
corepack pnpm demo:real-embed -- --reset --limit 50 --top-k 5
```

这个示例使用 DashScope 的 `qwen3.7-text-embedding`，默认维度为 1024，读取
`data/content/recall-demo/` 中正好 50 篇标准 MDX，并按 24 条 qrels 比较 baseline
和完整本地增强链。外部 rerank 只有显式传入 `--external-rerank` 才会调用。完整
前提、输出字段和能力开关见 [examples/real-embed/README.md](examples/real-embed/README.md)
及 [检索能力矩阵](docs/RETRIEVAL_FEATURES.md)。

## 文档入口

| 需要了解的内容                            | 文档                                                         |
| ----------------------------------------- | ------------------------------------------------------------ |
| 所有项目入口和目录边界                    | [INDEX.md](INDEX.md)                                         |
| 了解文档体系和阅读路径                    | [docs/README.md](docs/README.md)                             |
| 第一次接入                                | [docs/GUIDE.md](docs/GUIDE.md)                               |
| 配置和默认值                              | [docs/CONFIGURATION.md](docs/CONFIGURATION.md)               |
| 公开 API 和类型                           | [docs/API.md](docs/API.md)                                   |
| 检索能力、开关和诊断字段                  | [docs/RETRIEVAL_FEATURES.md](docs/RETRIEVAL_FEATURES.md)     |
| 自动选择策略、显式算法计划和 VCP 能力迁移 | [docs/RETRIEVAL_STRATEGIES.md](docs/RETRIEVAL_STRATEGIES.md) |
| 不可变 MDX 文件源和派生关系图             | [docs/RELATIONS.md](docs/RELATIONS.md)                       |
| `RetrievalPlan` 类型化算法计划            | [docs/RETRIEVAL_PLAN.md](docs/RETRIEVAL_PLAN.md)             |
| 架构和生命周期                            | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                 |
| 持久化、恢复和备份                        | [docs/PERSISTENCE.md](docs/PERSISTENCE.md)                   |
| 测试和验证                                | [docs/TESTING.md](docs/TESTING.md)                           |
| 常见故障                                  | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)           |
| 全部专题文档                              | [docs/INDEX.md](docs/INDEX.md)                               |
| 参与开发                                  | [CONTRIBUTING.md](CONTRIBUTING.md)                           |

## 运行检查

```powershell
corepack pnpm verify:docs
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

真实嵌入测试没有密钥时会明确跳过；这不等同于真实网络链路已验证。完整检查和 CI
说明见 [docs/TESTING.md](docs/TESTING.md)。

## 许可证

MIT © 2026 Arsvine Zhu
