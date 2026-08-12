# 数据与 MDX

## 逻辑文档

逻辑文档使用：

```ts
await engine.upsert({
  id: "stable-id",
  content: mdxText,
  format: "mdx",
  source: { type: "application", id: "source-id" },
  metadata: { owner: "team" },
});
```

id 是稳定身份；更新同一个身份使用 upsert() 或带 revision 的 ingest()。逻辑文档会进入 Logical space，并且不要求库拥有源文件路径。

## Filesystem snapshot

filesystem adapter 读取 MDX 文件并提交文件快照。front matter 会成为 metadata，正文会进入 chunking 和 embedding。相对 root 的第一级目录成为默认 space；调用者也可以通过正式文件输入显式指定 space。

推荐的 MDX 结构：

```mdx
---
title: 一条记忆
tags:
  - topic
recordedAt: 2026-01-01T12:00:00Z
status: active
---

# 正文

这里是可被 chunk 和检索的正文。
```

front matter 的 key 必须保持可序列化；正文应有实际内容。解析错误会以 ingestion error 报告，不会写入半成品状态。

## Relations

显式 relation 来自 source metadata 或正式 relation contract；derived relation 由 relation graph 阶段产生。relation 有 kind、origin、status、confidence、weight、provenance 和 source revision。关系扩展不是默认搜索的一部分，必须通过 `RetrievalPlan.expansion.related` 开启。

## 数据边界

- 仓库教程源数据只位于 tutorials/data/content/，全部为 .mdx。
- SQLite、vector index、tag artifacts、propagation history 和运行日志属于教程 runtime。
- package tarball 不包含 tutorials 或任何教程数据。
- 库消费者应自行决定 dataPath，不能假设仓库中存在可写的默认数据。
