# 05：扩展与重排

## 学习目标

区分基础排序、本地确定性重排和 external/model rerank，理解扩展阶段以及最终后处理的固定顺序。

## 前置条件

- 已完成 [04：RetrievalPlan 与 QueryBuilder](../04-retrieval-plans/README.md)。
- fake embedding/reranker 可以运行本章；完整配置时才会选择 OpenAI-compatible provider。

## 三层排序

1. 基础排序先融合 vector 与 BM25 候选。
2. 本地重排可以启用 embedding、propagation support 和 propagation structure；它们不访问网络。
3. 模型重排通过注入的 `ExternalReranker` 执行。选择由 `RetrievalPlan.externalRerank.enabled` 控制，函数对象通过 `MemoryEngineOptions.reranker` 注入。

模型重排不会默认执行。当前顺序是：

```text
candidate retrieval
→ merge
→ local retrieval stages / expansion
→ dedupe
→ external rerank
→ time decay
→ truncate
→ result format
```

这意味着 provider 返回的排序还会受到后续 time decay 和 truncate 的影响，但不会被另一个 candidate merge 覆盖。

## 完整代码

<!-- tutorial-code:start -->

```ts
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import FilesystemIngestionAdapter from "@arsvinezhu/memoria/adapters/filesystem";

import { createTutorialEngine } from "../_support/provider-config.js";
import { prepareTutorialRuntime, SHARED_CONTENT_ROOT } from "../_support/paths.js";
import { heading, printProviderSelection, printResults } from "../_support/terminal.js";

export async function run(): Promise<void> {
  // The helper injects the reranker; the query plan below explicitly selects it.
  // Local rerank stages remain deterministic and do not require this provider.
  const { engine, paths, providers } = createTutorialEngine(
    "05-expansion-and-reranking",
  );
  await prepareTutorialRuntime(paths);
  const filesystem = new FilesystemIngestionAdapter(engine, {
    rootPath: SHARED_CONTENT_ROOT,
    extensions: [".mdx"],
  });
  printProviderSelection(providers);

  try {
    await engine.initialize();
    await filesystem.scan();
    heading("local stages and external rerank");
    // This chain demonstrates the ordering contract: candidate generation and
    // local stages precede dedupe, external rerank precedes time decay/truncate.
    const envelope = await engine
      .query("旅行安排和行程准备")
      .associative()
      .tagBasisProjection()
      .tagResidualDecomposition()
      .activationPropagation()
      .propagationHistory()
      .embeddingRerank()
      .tagExpansion()
      .expand((expansion) => expansion.related().maxHops(1).maxAdded(10))
      .rerank((rerank) => rerank.ordered())
      .postprocess((postprocess) =>
        postprocess.timeDecay().dedupe().truncate().limit(5),
      )
      .run();
    console.log(`strategy=${envelope.retrieval?.strategy ?? "not returned"}`);
    printResults(envelope.results);
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
corepack pnpm tutorial:05
```

## Provider 选择

没有完整 `RERANK_*` 配置时，`rerank((builder) => builder.ordered())` 仍会执行 fake reranker，保证阶段顺序和 envelope 结构可观察；它不证明模型排序质量。配置完整后，库使用兼容协议适配器，超时、HTTP 错误或非法 JSON 会直接失败。

`rrf()` 可以替代 `ordered()`：

```ts
await engine
  .query(query)
  .rerank((rerank) => rerank.rrf({ alpha: 0.5 }))
  .run();
```

## 预期输出

输出会显示稳定的 `retrieval.strategy` 诊断。内部 stage 顺序不属于公开结果契约；结果中的 `rerankScore`、`decay`、`supportScore` 等字段取决于实际启用的阶段。

## 常见错误

- 只注入 reranker 而不在 plan 中开启 `externalRerank.enabled` 不会访问它。
- 只在 plan 中设置 external rerank 而没有注入 provider 会在执行阶段失败。
- `ordered` 与 `rrf` 是两种不同的融合方式，不能把它们描述成同一算法。
- native retrieval 不可用时应观察明确的 failure/skip 诊断，不应在教程中导入 native runtime。

## 下一章

继续阅读 [06：持久化与维护](../06-persistence-and-maintenance/README.md)。
