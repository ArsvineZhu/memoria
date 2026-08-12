# 08：Provider 选择

## 学习目标

理解教程如何在同一份代码中选择 fake 或 OpenAI-compatible embedding/reranker，并区分“流程可以运行”和“检索质量已经验证”。

## 前置条件

- 没有配置也可以直接运行。
- 如果要调用兼容服务，复制 `.env.example` 为 `.env`，填写完整的 `EMBED_*` 和/或 `RERANK_*` 配置。
- `.env` 只属于本地教程环境，不提交到 Git。

`.env` 的准确路径是 `tutorials/08-provider-selection/.env`。所有命令从仓库根目录执行：

```powershell
Copy-Item tutorials/08-provider-selection/.env.example tutorials/08-provider-selection/.env
notepad tutorials/08-provider-selection/.env
corepack pnpm tutorial:08
```

也可以不用文件，直接设置当前 PowerShell 进程的环境变量。进程环境变量优先于 `.env`；其他章节调用同一个 support provider 选择器，因此同样会读取这组配置。

## 选择规则

embedding 的四个核心字段都存在且有效时使用兼容协议 provider；否则使用 fake。reranker 的三个核心字段都存在且有效时使用兼容协议 reranker；否则使用 fake。partial 或 placeholder 值不会触发半配置请求。

provider 选择发生在教程 support 层。库本身仍要求调用者显式注入 provider；兼容服务请求开始后，错误不会再次隐式切换到 fake。

## 完整代码

<!-- tutorial-code:start -->

```ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createTutorialEngine } from "../_support/provider-config.js";
import { prepareTutorialRuntime, resolveSharedContentPath } from "../_support/paths.js";
import { heading, printProviderSelection, printResults } from "../_support/terminal.js";

export async function run(): Promise<void> {
  // provider-config.ts reads process.env first, then
  // tutorials/08-provider-selection/.env. Missing or placeholder values select
  // fake providers; a configured provider error is never hidden by fallback.
  const { engine, paths, providers } = createTutorialEngine("08-provider-selection");
  await prepareTutorialRuntime(paths);
  printProviderSelection(providers);

  try {
    await engine.initialize();
    // The same application code works with either provider selection.
    const content = await readFile(
      resolveSharedContentPath("travel/yunnan-itinerary.mdx"),
      "utf8",
    );
    await engine.ingest({
      id: "tutorial:provider-selection:itinerary",
      content,
      format: "mdx",
    });
    heading("the same code works with fake or configured providers");
    // RRF is a public external-rerank mode selected by this query plan.
    const result = await engine
      .query("旅行行程准备")
      .rerank((rerank) => rerank.rrf({ alpha: 0.5 }))
      .postprocess((postprocess) => postprocess.limit(3))
      .run();
    printResults(result.results);
  } finally {
    await engine.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void run().catch((error: unknown) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exitCode = 1;
  });
}
```

<!-- tutorial-code:end -->

## 运行命令

```powershell
corepack pnpm tutorial:08
```

## 环境变量

```text
EMBED_API_URL
EMBED_API_KEY
EMBED_MODEL
EMBED_DIMENSION
EMBED_CONCURRENCY
RERANK_API_URL
RERANK_API_KEY
RERANK_MODEL
RERANK_TIMEOUT_MS
```

这些字段描述 OpenAI-compatible 协议所需的调用参数，不包含任何厂商默认值。`EMBED_API_URL`、`EMBED_API_KEY`、`EMBED_MODEL`、`EMBED_DIMENSION` 是 embedding 的必填选择字段；`EMBED_CONCURRENCY` 有默认值。`RERANK_API_URL`、`RERANK_API_KEY`、`RERANK_MODEL` 是 reranker 的必填选择字段；`RERANK_TIMEOUT_MS` 有默认值。完整变量清单见 [`.env.example`](.env.example)。

## 预期输出

启动时会明确打印当前 embedding 和 reranker provider。无配置时应看到 `fake`；完整配置时应看到 `openai-compatible`。无配置模式只验证生命周期、请求形状和结果 envelope，不验证召回质量。

## 常见错误

- 只配置 URL 而没有 key/model/dimension 时仍会使用 fake。
- dimension 与远端实际返回向量长度不一致会导致 embedding 错误。
- 配置的 reranker 返回非 JSON 数组、非法 candidate score 或 HTTP 错误时，程序应失败并保留错误分类。
- 不要把密钥写入 `.env.example` 或 README。

## 下一章

教程章节到此结束；接下来阅读 [Public API 参考](../reference/public-api.md) 或 [算法总览](../algorithms/README.md)。
