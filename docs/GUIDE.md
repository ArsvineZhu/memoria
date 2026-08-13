# 快速上手

本文面向第一次使用 `memoria` 的人，按“安装 → 运行第一个教程 → 保存文字 → 读取文件 →
搜索和删除”的顺序说明。完整配置请看
[CONFIGURATION.md](CONFIGURATION.md)，公开接口请看 [API.md](API.md)，检索增强能力和
诊断字段请看 [RETRIEVAL_FEATURES.md](RETRIEVAL_FEATURES.md)。

## 1. 准备环境

- Node.js：`>=24.18.1 <25`；
- pnpm：`11.20.0`，通过 Corepack 使用；
- 当前平台可用的 `rust-vexus-lite` 原生文件；
- 依赖安装命令：

```powershell
corepack pnpm install --frozen-lockfile
```

如果只想确认仓库能运行，先执行第一个教程：

```powershell
corepack pnpm build:test
node dist-test/tutorials/01-first-memory/main.js
```

没有完整 `EMBED_*` 配置时，它使用教程 fake embedding；fake 只保证生命周期、输出形状
和关闭行为。教程读取 `tutorials/data/content/retrieval/`，运行时内容写入对应教程的
`tutorials/01-first-memory/data/runtime/`。

想按章节查看完整流程时，再运行：

```powershell
corepack pnpm tutorials:run
```

每个 `tutorials/<lesson>/main.ts` 都是可运行的公开 API 示例；完整章节说明、参考手册和
算法解释位于 `tutorials/<lesson>/README.md`、`tutorials/reference/` 和
`tutorials/algorithms/`。

## 2. 保存和搜索一段文字

`MemoryEngine` 的逻辑接口不要求文件路径，适合由应用自己管理文档：

```ts
// 这是调用形状示例；运行时请替换为应用自己的嵌入 Provider。
import { createMemoryEngine } from "@arsvinezhu/memoria";
import type { EmbeddingProviderContract } from "@arsvinezhu/memoria";

declare const embeddingProvider: EmbeddingProviderContract;

const engine = createMemoryEngine({
  config: {
    dataPath: "./data",
    dimension: 128,
    topK: 5,
  },
  embeddingProvider,
});

await engine.initialize();

await engine.ingest({
  id: "note:coffee",
  content: "手冲咖啡：水温 93 度，粉水比 1:15。",
  revision: "1",
  metadata: { topic: "coffee" },
});

const found = await engine.search("手冲 萃取参数", { topK: 3 });
console.log(found.results);

await engine.remove("note:coffee");
await engine.close();
```

使用自己的嵌入 Provider 时，`embeddingProvider.getDimension()` 必须和
`config.dimension` 相同。维度不同时，向量不能写入原索引；更换维度后需要重新
摄入全部文档。

默认搜索只做向量/BM25 基础融合。若要启用模型重排，应从
`@arsvinezhu/memoria/providers/openai-compatible` 创建 reranker，传入 `MemoryEngineOptions.reranker`，
并在 `retrievalPlan.externalRerank.enabled` 中显式开启；详见 [API.md](API.md)。

## 3. 从文件摄入

推荐的文件目录如下：

```text
<consumer-data>/
├─ content/                 # 调用方维护的源文件
│  ├─ life/coffee.mdx
│  └─ memory/example.mdx
├─ memoria/                 # 主引擎生成状态
│  ├─ memory.sqlite
│  └─ indexes/
└─ tdb/                      # TDB 生成状态
```

MDX 文件开头可以写 front matter：

```mdx
---
title: 手冲咖啡
tags:
  - 咖啡
recordedAt: 2026-08-08T09:30:00-06:00
---

# 正文

正文会被读取、分块和嵌入。
```

规则很简单：

- `tags` 会加入标签；
- 其他 JSON 兼容字段会进入结果的 `metadata`；
- front matter 不会进入正文分块；
- MDX/JSX 不会执行；
- 没有 front matter 的 `.md` 仍可读取；
- 只修改 front matter 时，正文向量可以复用。

需要扫描目录或监听文件变化时，使用 `@arsvinezhu/memoria/adapters/filesystem`。适配器负责
读取和报告文件变化，真正的内容写入仍由 `MemoryEngine` 完成。文件适配器的完整
参数以 [API.md](API.md) 和 `src/adapters/filesystem-ingestion-adapter.ts` 为准。

## 4. 常用操作

| 操作          | 调用                                   | 结果                             |
| ------------- | -------------------------------------- | -------------------------------- |
| 初始化        | `await engine.initialize()`            | 打开数据库、恢复或重建索引       |
| 写入/更新文字 | `await engine.ingest(document)`        | 写入一篇逻辑文档                 |
| 搜索          | `await engine.search(query, options?)` | 返回结果信封和结果数组           |
| 删除逻辑文档  | `await engine.remove(documentId)`      | 按文档 ID 删除，不依赖原文件路径 |
| 删除文件      | `await engine.deleteFile(filePath)`    | 删除单个文件及其块向量           |
| 文件快照摄入  | `await engine.flushBatch(files)`       | 处理文件快照或路径               |
| 查看统计      | `await engine.getStats()`              | 文件、块、标签、索引和健康状态   |
| 关闭          | `await engine.close()`                 | 等待写入、保存索引并关闭资源     |

删除未知文档是幂等的。标签记录可能被其他文件共享，因此删除一篇文档不会盲目
删除全局标签。项目没有一个“清空全部数据”的安全快捷 API；需要清空时应使用新
的 `dbPath`/`storePath`，或由应用逐项删除并确认备份。

## 5. 最常用的配置

| 目的                 | 配置                                      |
| -------------------- | ----------------------------------------- |
| 改变所有默认数据位置 | `dataPath`                                |
| 指定文件源目录       | `rootPath`                                |
| 指定主向量索引目录   | `storePath`                               |
| 指定主 SQLite 文件   | `dbPath` 或顶层 `options.dbPath`          |
| 改变返回条数         | `topK`                                    |
| 打开标签/记忆算法    | 对应的 `...Enabled` 开关                  |
| 改变分块大小         | `chunkMaxTokens`、`chunkOverlapTokens`    |
| 改变向量维度         | `dimension`，同时更换 Provider 的输出维度 |

所有 canonical 字段、默认值和 TDB 参数见
[CONFIGURATION.md](CONFIGURATION.md)。

## 6. 选择 embedding 与 reranker provider

教程统一按配置选择 provider，不区分教程是否联网：

1. 复制 `tutorials/08-provider-selection/.env.example` 为
   `tutorials/08-provider-selection/.env`，再写入完整的 `EMBED_*` 配置；
2. 运行（`--reset` 只清理固定的演示运行时目录）：

```powershell
Copy-Item tutorials/08-provider-selection/.env.example tutorials/08-provider-selection/.env
corepack pnpm tutorial:08
```

完整 `EMBED_*`/`RERANK_*` 配置时使用 OpenAI-compatible provider；缺少完整配置时使用
fake，只保证流程可运行。兼容 provider 请求开始后失败不会回退。详见
[08-provider-selection](../tutorials/08-provider-selection/README.md) 和
[算法手册](../tutorials/algorithms/README.md)。

## 7. 下一步

- 看 [CONFIGURATION.md](CONFIGURATION.md) 调整参数；
- 看 [PERSISTENCE.md](PERSISTENCE.md) 了解备份、恢复和索引重建；
- 看 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) 处理运行故障；
- 看 [TESTING.md](TESTING.md) 运行完整验证。
