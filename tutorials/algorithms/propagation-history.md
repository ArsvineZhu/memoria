# Propagation History

## 目标

Propagation History 将一次查询的传播观察保存为有序历史，使后续查询可以使用时间/序列上下文，而不是只看当前 graph state。

## 输入与输出

输入：

- 当前 propagation/graph observation；
- history store；
- \`RetrievalPlan.propagationHistory.enabled\`；
- history length、decay、support 等配置。

输出字段使用 canonical 结构：

- \`sequence\`：历史序列标识；
- \`edgeTotals\`：按 edge 累计的传播量；
- \`spreadClass\`、\`spreadScore\`、\`historySupport\` 等传播诊断。

## 阶段与持久化

本阶段位于 Graph Diffusion 之后、结构/support 重排之前。关闭 plan section 时不会写入历史。历史数据属于 SQLite relational adaptive state，不是源 MDX 或可重建 artifact 的一部分；持久化失败时应报告 `history-persistence-failed` 或跳过状态，不能静默改写为旧格式。

## 语义

每次观察按 sequence 记录，edgeTotals 汇总这次或累计窗口内的边支持。后续查询可以将历史支持作为附加信号，但它不应覆盖当前查询的基础分数。历史读取和写入由内部 context 注入，应用只通过公开结果的 diagnostics/trace 观察。

## 边界

- 没有传播状态时，不能生成有意义的 history。
- 空 graph 或空 edge totals 是合法空结果。
- 数据库 schema/payload 不匹配属于 persistence 错误，应重新创建数据库；本次 hard reset 不迁移旧历史。
- 清理 runtime 数据会同时清理教程运行产生的 history，源 MDX 不受影响。

源码：[propagation-history.ts](../../src/stages/tag-retrieval/propagation-history.ts)、[sqlite-metadata-store.ts](../../src/providers/sqlite-metadata-store.ts)。
