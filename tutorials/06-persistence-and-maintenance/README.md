# 06：持久化与维护

## 学习目标

理解 SQLite metadata、vector index 和 derived artifacts 的关系，学习 `getStats`、`listFiles`、`reconcile`、重开和 schema fail-fast。

## 前置条件

- 已完成 [05：扩展与重排](../05-expansion-and-reranking/README.md)。
- 本章使用教程自己的 `data/runtime/`；删除它后可以重新观察 fresh database。
- 没有完整 `EMBED_*` 配置时使用 fake embedding；完整配置时使用 OpenAI-compatible
  embedding provider。fake 只用于验证持久化生命周期，不代表检索质量。

## 持久化边界

SQLite 是文件、chunk、tag、relation 和 derived metadata 的 authority；vector index 是可重建的 derived state。空数据库初始化时建立 canonical schema 并写 `PRAGMA user_version = 1`。非空数据库如果版本、表或列不符合 contract，会抛 `MemoriaError`，不会执行 additive migration，也不会自动删除旧数据库。

`data/runtime/` 只属于教程运行过程。库消费者应通过自己的 `dataPath`、`dbPath` 和 `storePath` 管理运行时数据。

## 完整代码

<!-- tutorial-code:start -->

```ts
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import FilesystemIngestionAdapter from "@arsvinezhu/memoria/adapters/filesystem";

import { createTutorialEngine } from "../_support/provider-config.js";
import { prepareTutorialRuntime, SHARED_CONTENT_ROOT } from "../_support/paths.js";
import { heading, printProviderSelection } from "../_support/terminal.js";

export async function run(): Promise<void> {
  // Each lesson owns its runtime directory; the source MDX stays read-only.
  const first = createTutorialEngine("06-persistence-and-maintenance");
  await prepareTutorialRuntime(first.paths);
  printProviderSelection(first.providers);

  const filesystem = new FilesystemIngestionAdapter(first.engine, {
    rootPath: SHARED_CONTENT_ROOT,
    extensions: [".mdx"],
  });
  try {
    await first.engine.initialize();
    await filesystem.scan();
    heading("authoritative metadata and derived indexes");
    // SQLite is authoritative; vector indexes and tag artifacts are derived
    // state that reconcile() can rebuild from the stored metadata.
    console.log(await first.engine.getStats());
    console.log(`files=${(await first.engine.listFiles()).length}`);
    console.log(await first.engine.reconcile());
  } finally {
    await filesystem.close();
    await first.engine.close();
  }

  heading("reopen the canonical database");
  // A second engine instance proves that the canonical database and indexes can
  // be reopened without any compatibility migration.
  const reopened = createTutorialEngine("06-persistence-and-maintenance");
  await prepareTutorialRuntime(reopened.paths);
  try {
    await reopened.engine.initialize();
    console.log(`reopened files=${(await reopened.engine.getStats()).files}`);
  } finally {
    await reopened.engine.close();
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
corepack pnpm tutorial:06
```

## 预期输出

程序会显示文件、chunk、tag、space 和 vector 统计，执行一次 reconcile，然后重新打开相同 SQLite 并读取文件数量。

## 常见错误

- 从旧 schema 继续启动不会得到自动转换；应创建新的数据库和 derived artifacts。
- 只恢复 SQLite 而没有 vector index 时，`initialize()` 会尝试从 authority 重建 derived state。
- 修改 `dimension` 后复用旧 index 会产生维度错误；应使用匹配维度的新运行时目录。
- `reconcile()` 解决的是 derived state 一致性，不是迁移任意旧 schema。

## 下一章

继续阅读 [07：TDB 子系统](../07-tdb/README.md)。
