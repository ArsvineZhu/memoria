# memoria：给 AI 应用使用的持久化记忆库

`memoria` 可以把文字保存下来，并在之后按意思或关键词找回。它同时保存
原文、标签和向量，关闭程序后数据仍可恢复。默认数据放在项目的 `data/` 目录，
源文件和运行状态分开管理。

## 你可以用它做什么

- 用关键词和语义一起搜索，减少“换一种说法就找不到”的情况；
- 自动从文档提取标签，并按标签扩展相关记忆；
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

演示会读取 `data/content/` 中的三篇 MDX 文件，执行初始化、摄入、搜索、删除和
关闭六个步骤，并把演示用的数据库和索引写入 `data/memoria/demo/`。源文件不会被
覆盖。详细说明见 [examples/demo/README.md](examples/demo/README.md)。

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

没有 front matter 的 `.md` 文件仍然可以读取，但 `.md` 和逻辑文档不会自动解析
front matter。只改标题或标签时，系统会尽量复用正文向量，不重复计算正文嵌入。
数据目录的备份和清理规则见
[data/README.md](data/README.md)。

## 使用真实嵌入

真实嵌入是可选的。把 `EMBED_API_KEY=...` 写入
`examples/real-embed/.env`，然后运行：

```powershell
corepack pnpm build:test
node dist-test/examples/real-embed/demo-recall.js
```

这个示例使用 DashScope 的 `qwen3.7-text-embedding`，维度为 1024。它会读取
测试资料并打印六组查询的召回结果。完整前提和无密钥行为见
[examples/real-embed/README.md](examples/real-embed/README.md)。

## 文档入口

| 需要了解的内容         | 文档                                               |
| ---------------------- | -------------------------------------------------- |
| 所有项目入口和目录边界 | [INDEX.md](INDEX.md)                               |
| 了解文档体系和阅读路径 | [docs/README.md](docs/README.md)                   |
| 第一次接入             | [docs/GUIDE.md](docs/GUIDE.md)                     |
| 配置和默认值           | [docs/CONFIGURATION.md](docs/CONFIGURATION.md)     |
| 公开 API 和类型        | [docs/API.md](docs/API.md)                         |
| 架构和生命周期         | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)       |
| 持久化、恢复和备份     | [docs/PERSISTENCE.md](docs/PERSISTENCE.md)         |
| 测试和验证             | [docs/TESTING.md](docs/TESTING.md)                 |
| 常见故障               | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) |
| 全部专题文档           | [docs/INDEX.md](docs/INDEX.md)                     |
| 参与开发               | [CONTRIBUTING.md](CONTRIBUTING.md)                 |

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
