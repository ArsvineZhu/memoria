# 07：TDB 子系统

## 学习目标

了解 TDB 的独立生命周期和三个正式入口：`TDBEngine`、`TDBStore`、`TriviumDBAdapter`。TDB 术语保持不变，不与 `MemoryEngine` 的 tag retrieval 混为一谈。

## 前置条件

- 已完成 [06：持久化与维护](../06-persistence-and-maintenance/README.md)。
- 没有完整 `EMBED_*` 配置时使用 fake embedding；完整配置时使用 OpenAI-compatible
  embedding provider。TDB 结果用于说明 API 和生命周期，不用于评估模型质量。

## TDB 的边界

`TDBEngine` 面向独立的 cold-knowledge corpus，使用 `tdb*` 配置和自己的 SQLite/vector store。`TDBStore` 是 TDB metadata contract 的 SQLite 实现；`TriviumDBAdapter` 是一个可注入 vector/metadata backend 的适配器。它们都从 root package 导出，但不把内部 pipeline 暴露给调用者。

## 完整代码

<!-- tutorial-code:start -->

```ts
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TDBEngine, TDBStore, TriviumDBAdapter } from "@arsvinezhu/memoria";

import { selectTutorialProviders } from "../_support/provider-config.js";
import {
  prepareTutorialRuntime,
  resolveTutorialPaths,
  SHARED_CONTENT_ROOT,
} from "../_support/paths.js";
import { heading, printProviderSelection } from "../_support/terminal.js";

export async function run(): Promise<void> {
  // TDB uses the same tutorial provider selection, but has its own lifecycle
  // and configuration namespace separate from MemoryEngine.
  const providers = selectTutorialProviders();
  const paths = resolveTutorialPaths("07-tdb");
  await prepareTutorialRuntime(paths);
  printProviderSelection(providers);

  const engine = new TDBEngine({
    embeddingProvider: providers.embeddingProvider,
    config: {
      tdbEnabled: true,
      tdbRootPath: SHARED_CONTENT_ROOT,
      tdbStorePath: paths.indexPath,
      tdbDbPath: resolve(paths.runtimeRoot, "tdb.sqlite"),
      tdbDimension: providers.embeddingProvider.getDimension(),
      tdbTopK: 5,
    },
  });

  try {
    await engine.initialize();
    heading("TDBEngine lifecycle");
    // TDB stores facts in its own library scope; it is not MemoryEngine space.
    await engine.upsertText("TDB stores a separate cold-knowledge corpus.", {
      library: "tutorial",
      path: "notes/tdb-introduction.mdx",
    });
    const result = await engine.search("cold knowledge", {
      libraries: ["tutorial"],
      topK: 3,
    });
    console.log(`tdb results=${result.results.length}`);
    console.log(await engine.getStats());
  } finally {
    await engine.close();
  }

  heading("TDBStore and TriviumDBAdapter are separate public contracts");
  // These are independent root exports for callers that need direct store or
  // adapter composition instead of the TDBEngine lifecycle wrapper.
  const store = new TDBStore({
    dbPath: resolve(paths.runtimeRoot, "standalone-tdb.sqlite"),
  });
  try {
    const adapter = new TriviumDBAdapter({
      metadataStore: store,
      dimension: providers.embeddingProvider.getDimension(),
    });
    console.log(
      `adapter results=${(await adapter.search(new Float32Array(providers.embeddingProvider.getDimension()), 1)).length}`,
    );
  } finally {
    store.close();
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
corepack pnpm tutorial:07
```

## 预期输出

程序会初始化 TDB、写入一条文本、执行搜索并打印 TDB stats，然后独立创建 `TDBStore` 和 `TriviumDBAdapter`。

## 常见错误

- `tdbEnabled` 未开启时，TDB 操作会返回 disabled envelope，而不是普通 MemoryEngine 结果。
- `tdbDimension` 必须与注入的 embedding provider 一致。
- 不应把 TDB 的 `libraries` 当作 MemoryEngine 的 `spaces`；两者属于不同 subsystem。

## 下一章

继续阅读 [08：Provider 选择](../08-provider-selection/README.md)。
