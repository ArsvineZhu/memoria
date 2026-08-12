# 03：搜索与作用域

## 学习目标

理解基础检索如何融合 vector 与 BM25，掌握 `topK`、`spaces`、过滤器、结果字段，以及直接调用和 QueryBuilder 两种写法。

## 前置条件

- 先完成前两章。
- 无 provider 配置也可以运行；fake embedding 只用于验证 API 和生命周期。

## 基础排序

基础搜索先得到向量候选和 BM25 候选，再合并、去重和排序。默认搜索不会调用网络，也不会自动调用模型 reranker。`spaces` 是持久化文件的逻辑作用域；本例中的目录名 `learning` 会成为 space。

## Object-style 与 chain-style

直接调用适合参数来自配置对象或请求对象的场景：

```ts
await engine.search(query, { spaces: ["learning"], topK: 5 });
```

链式调用适合逐步构造不可变 retrieval plan：

```ts
await engine
  .query(query)
  .where((scope) => scope.space("learning"))
  .postprocess((postprocess) => postprocess.limit(5))
  .run();
```

两种形式只在语义和默认继承设置相同时等价；`QueryBuilder` 不替代生命周期、摄入和维护 API。

## 完整代码

<!-- tutorial-code:start -->

```ts
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import FilesystemIngestionAdapter from "memoria/adapters/filesystem";

import { createTutorialEngine } from "../_support/provider-config.js";
import { prepareTutorialRuntime, SHARED_CONTENT_ROOT } from "../_support/paths.js";
import { heading, printProviderSelection, printResults } from "../_support/terminal.js";

export async function run(): Promise<void> {
  const { engine, paths, providers } = createTutorialEngine("03-search-and-scope");
  await prepareTutorialRuntime(paths);
  const filesystem = new FilesystemIngestionAdapter(engine, {
    rootPath: SHARED_CONTENT_ROOT,
    extensions: [".mdx"],
  });
  printProviderSelection(providers);

  try {
    await engine.initialize();
    // The adapter loads the shared MDX corpus once; both searches below use the
    // same authoritative metadata and vector indexes.
    await filesystem.scan();

    heading("object-style search");
    // Object-style search keeps the complete request in one serializable value.
    const objectStyle = await engine.search("SQL 查询性能和索引", {
      spaces: ["learning"],
      topK: 5,
    });
    printResults(objectStyle.results);

    heading("chain-style search");
    // QueryBuilder is immutable: each call returns a new builder and run()
    // normalizes the chain into the same public search contract.
    const chainStyle = await engine
      .query("SQL 查询性能和索引")
      .where((scope) => scope.space("learning"))
      .postprocess((postprocess) => postprocess.limit(5))
      .run();
    console.log(
      `object results=${objectStyle.results.length} chain results=${chainStyle.results.length}`,
    );
  } finally {
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
corepack pnpm tutorial:03
```

## 结果字段

常见结果包括 `score`、`content`、`path`、`relPath`、`space`、`chunkId`、`chunkIndex`、`metadata`、`tags` 和 `matchedTags`。启用对应阶段后还可能出现 `rerankScore`、`decay`、`supportScore` 等诊断字段。

## 预期输出

两种写法都会打印 `learning` space 中的候选，并输出两者的结果数量。fake provider 下分数仅用于说明结果结构。

## 常见错误

- `spaces` 名称必须与文件实际 space 一致。
- 空数组和未提供过滤器的语义不同，具体行为以 `SearchOptions` 和过滤器说明为准。
- 只改变 `topK` 不会开启任何额外检索阶段。

## 下一章

继续阅读 [04：RetrievalPlan 与 QueryBuilder](../04-retrieval-plans/README.md)。
