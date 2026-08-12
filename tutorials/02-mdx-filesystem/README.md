# 02：MDX 与 filesystem adapter

## 学习目标

学习如何把一组 MDX 文件交给正式的 filesystem adapter，并理解 front matter、space、scan、sync、删除和运行时目录之间的边界。

## 前置条件

- 先阅读 [01：第一次创建 MemoryEngine](../01-first-memory/README.md)。
- 教程语料位于 `tutorials/data/content/retrieval/`，全部是 `.mdx`。
- 教程不会修改源 MDX；删除操作只删除库内的 metadata/vector 状态。
- 没有完整 `EMBED_*` 配置时使用 fake embedding；完整配置时使用 OpenAI-compatible
  embedding provider。两种选择运行相同的 filesystem 流程，fake 只保证流程可运行。

## 核心概念

filesystem adapter 负责读取文件、解析 MDX front matter、检查路径是否位于 root 下，并把完整快照交给 engine。相对路径的第一级目录成为默认 `space`，例如 `learning/sql-indexing.mdx` 属于 `learning`。`scan()` 只摄入现有文件；`sync()` 还会根据 authoritative metadata 删除 root 下已经不存在的文件。

## 完整代码

<!-- tutorial-code:start -->

```ts
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import FilesystemIngestionAdapter from "memoria/adapters/filesystem";

import { createTutorialEngine } from "../_support/provider-config.js";
import { prepareTutorialRuntime, SHARED_CONTENT_ROOT } from "../_support/paths.js";
import { heading, printProviderSelection } from "../_support/terminal.js";

export async function run(): Promise<void> {
  const { engine, paths, providers } = createTutorialEngine("02-mdx-filesystem");
  await prepareTutorialRuntime(paths);
  // FilesystemIngestionAdapter is the supported file boundary: it reads MDX,
  // parses front matter, and delegates the resulting snapshot to the engine.
  const filesystem = new FilesystemIngestionAdapter(engine, {
    rootPath: SHARED_CONTENT_ROOT,
    extensions: [".mdx"],
  });
  printProviderSelection(providers);

  try {
    await engine.initialize();
    heading("scan and sync");
    // scan reports source files; sync additionally writes new/changed files and
    // removes authoritative rows whose source files disappeared.
    const scanned = await filesystem.scan();
    const sync = await filesystem.sync();
    console.log(
      `scanned=${scanned.length} sync.ingested=${sync.ingested} unchanged=${sync.unchanged}`,
    );

    heading("delete one metadata snapshot without touching the source file");
    const files = await engine.listFiles();
    const first = files[0];
    if (first) {
      // Removing a snapshot from the engine does not delete the user-owned MDX
      // source. A later scan can ingest it again.
      await filesystem.removeFile(resolve(SHARED_CONTENT_ROOT, first.path));
      console.log(`removed metadata for ${first.path}; the MDX source remains on disk`);
      await filesystem.scan();
    }
  } finally {
    // Close the adapter before the engine because the adapter may own a watcher
    // that still references the engine.
    await filesystem.close();
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
corepack pnpm tutorial:02
```

## 预期输出

程序会显示扫描数量、同步统计和一个被删除后重新扫描的 metadata 文件。源 MDX 仍然存在，因此下一次 `scan()` 可以重新建立索引。

## 常见错误

- `rootPath` 不是目录时，adapter 无法启动。
- 传入 root 之外的文件会被拒绝，避免路径穿越。
- MDX front matter 无法解析时，sync 会记录错误而不会把半解析内容写入数据库。
- `dataPath` 只指向运行时目录，不应指向 package 内部路径。

## 下一章

继续阅读 [03：搜索与作用域](../03-search-and-scope/README.md)。
