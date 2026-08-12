# 教程数据

这里保存教程使用的只读 MDX 源语料。它们属于教程，不属于 `memoria` 库的随包数据。

- `content/retrieval/` 是当前保留的检索语料，全部为 `.mdx`。
- 教程运行时产生的 SQLite 数据库、vector index 和 derived artifacts 位于各章节自己的 `data/runtime/`。
- `data/runtime/` 不纳入版本控制，也不会进入 package tarball。
- 库消费者可以通过 `dataPath` 指定自己的运行时目录；该配置不代表仓库内存在随包数据。
