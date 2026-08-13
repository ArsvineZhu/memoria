# 04：RetrievalPlan 与 QueryBuilder

## 学习目标

掌握 `auto`、`semantic`、`associative`、`structural` 四种策略，理解 `RetrievalPlan` 的 section、`explain()`、trace 和不可变链式调用。

## 前置条件

- 已完成 [03：搜索与 scope](../03-search-and-scope/README.md)。
- 没有 provider 配置时会使用 fake embedding；这里只验证 plan 和生命周期，不验证召回质量。

## 策略与 plan

- `auto` 根据 query profile、图就绪状态和可用候选选择策略。
- `semantic` 以基础语义检索为核心。
- `associative` 允许 tag basis、residual、propagation、support、embedding 和 tag expansion 等关联阶段。
- `structural` 允许 propagation structure 和 relation expansion 等结构阶段。

`RetrievalPlan` 只包含 `associative`、`structural`、独立的 `propagationHistory`、`filters`、`externalRerank`、`expansion` 和 `postprocess`。没有版本选择 section，也没有旧策略字段。

## Object-style 与 chain-style

object-style 适合传递完整 plan：

```ts
await engine.search(query, { retrievalPlan });
```

chain-style 适合逐步表达意图：

```ts
const builder = engine
  .query(query)
  .withoutDefaults()
  .associative()
  .tagBasisProjection()
  .tagResidualDecomposition()
  .activationPropagation();
```

`withoutDefaults()` 和 `withDefaults()` 明确控制是否继承 engine 的 default plan。builder 是 immutable；每次调用都会返回新 builder。互相矛盾的 core strategy 会抛出错误。

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
  const { engine, paths, providers } = createTutorialEngine("04-retrieval-plans");
  await prepareTutorialRuntime(paths);
  const filesystem = new FilesystemIngestionAdapter(engine, {
    rootPath: SHARED_CONTENT_ROOT,
    extensions: [".mdx"],
  });
  printProviderSelection(providers);

  try {
    await engine.initialize();
    await filesystem.scan();

    // A RetrievalPlan makes strategy selection and every enabled stage explicit.
    const retrievalPlan = {
      strategy: "associative" as const,
      associative: {
        enabled: true,
        tagBasisProjection: true,
        tagResidualDecomposition: true,
        tagGraphPropagation: true,
      },
      filters: { spaces: ["learning"] },
      postprocess: { dedupe: true, maxResults: 5 },
    };

    heading("explain and run an object-style plan");
    // explain resolves strategy/readiness without executing candidate retrieval.
    const explanation = await engine.explain("索引和查询性能", { retrievalPlan });
    console.log(`strategy=${explanation.decision.strategy}`);
    const objectStyle = await engine.search("索引和查询性能", { retrievalPlan });
    console.log(`object strategy=${objectStyle.retrieval?.strategy ?? "not returned"}`);

    heading("run the equivalent immutable chain");
    // withoutDefaults() prevents engine defaults from changing this comparison;
    // the chain then expresses the same strategy, scope, and postprocess stages.
    const chain = engine
      .query("索引和查询性能")
      .withoutDefaults()
      .associative()
      .tagBasisProjection()
      .tagResidualDecomposition()
      .activationPropagation()
      .where((scope) => scope.space("learning"))
      .postprocess((postprocess) => postprocess.dedupe().limit(5));
    // toPlan() is useful for inspecting the normalized plan before execution.
    console.log(`chain strategy=${chain.toPlan().strategy}`);
    const chainStyle = await chain.run();
    console.log(`chain results=${chainStyle.results.length}`);
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
corepack pnpm tutorial:04
```

## 预期输出

程序会打印 explanation 解析出的策略、规范化 plan，以及 object-style 和 chain-style 的结果数量。公开 envelope 只保证 `retrieval.strategy`、`retrieval.plan`、`retrieval.evidence` 和 `retrieval.fallbacks`；不能假定每个自定义 provider 都会补充额外诊断。

## 常见错误

- 同一个 builder 同时选择不同 core strategy 会失败。
- `QueryBuilder.run()` 不接受 `retrievalPlan` 和 `inheritRetrievalDefaults`，这两个选项必须在 builder 上配置。
- `associative` 或 `structural` 阶段的 section 关闭时，plan 不代表阶段一定产生有效信号；应检查 `retrieval.evidence` 和 `retrieval.fallbacks`。

## 下一章

继续阅读 [05：扩展与重排](../05-expansion-and-reranking/README.md)。
