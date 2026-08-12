# 01：第一次创建 MemoryEngine

## 学习目标

完成一个最小但完整的生命周期：创建 engine、注入 embedding provider、初始化、摄入 MDX、搜索、删除逻辑文档、flush 和关闭。

## 前置条件

- Node.js 和 pnpm 已按根目录 `package.json` 配置。
- 在仓库根目录执行命令。
- 没有 provider 配置也可以运行；此时使用 fake embedding，不能据此判断召回质量。

## 核心概念

`createMemoryEngine` 只创建对象；SQLite、vector store 和检索上下文在 `initialize()` 时打开。`upsert()` 适合没有文件系统路径的逻辑文档，`flushBatch()` 适合文件快照。搜索始终要在初始化完成后执行。关闭必须放在 `finally` 中。

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
  // The tutorial helper injects either a fake provider or a configured
  // OpenAI-compatible provider; the library itself never chooses a fallback.
  const { engine, paths, providers } = createTutorialEngine("01-first-memory");
  await prepareTutorialRuntime(paths);
  printProviderSelection(providers);

  try {
    // initialize validates the canonical SQLite schema and restores indexes.
    await engine.initialize();
    const sourcePath = resolveSharedContentPath("work/api-decision.mdx");
    const source = await readFile(sourcePath, "utf8");

    heading("upsert and search");
    // upsert is the host-neutral logical-document API; it does not require a
    // filesystem adapter or a source file path.
    await engine.upsert({
      id: "tutorial:first-memory:api-decision",
      content: source,
      format: "mdx",
      source: { type: "tutorial", id: sourcePath },
    });
    // Object-style search is useful when options are assembled dynamically.
    const envelope = await engine.search("幂等写入和数据一致性", { topK: 3 });
    printResults(envelope.results);

    heading("remove and close");
    // remove deletes the logical document and its derived vectors. flush makes
    // pending vector writes durable before the final lifecycle close.
    await engine.remove("tutorial:first-memory:api-decision");
    await engine.flush();
    console.log("The logical document was removed and the engine is ready to close.");
  } finally {
    // Always close in finally so an ingestion or search error cannot leave
    // SQLite handles or vector-index timers open.
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
corepack pnpm tutorial:01
```

## 预期输出

输出会先说明 `fake` 或 `openai-compatible` provider，然后打印至少一个结果，最后显示逻辑文档已经删除。fake provider 下结果顺序只用于演示流程，不代表模型质量。

## 常见错误

- 在 `initialize()` 前调用 `search()` 会得到 lifecycle 错误。
- provider 维度与配置 `dimension` 不一致会在初始化或摄入时失败。
- 重复使用相同 `id` 时应使用 `upsert()`，不要依赖随机路径去重。

## 下一章

继续阅读 [02：MDX 与 filesystem adapter](../02-mdx-filesystem/README.md)。
