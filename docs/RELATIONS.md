# Relations 和不可变文件源

`memoria` 将用户管理的文件/逻辑文档与检索产生的 relation records 分开。源文件是
可审查的 authority；`memory_relations` 是 SQLite 中可重建、可审计的关系 authority；
graph artifacts 和 propagation history 是 derived retrieval state。

## 文件源

```text
<dataPath>/content/**/*.mdx      用户源文件
<dataPath>/memoria/memory.sqlite metadata、chunks、tags、relations
<dataPath>/memoria/indexes/      vector indexes
```

`memoria/adapters/filesystem` 读取文件快照、解析允许的 front matter 和静态 links，
再交给 `MemoryEngine.flushBatch()`。它不会把检索结果写回源文件。

逻辑文档使用 `MemoryEngine.ingest({ id, content, metadata })`，不需要 filesystem path。
`format: "text"` 保持正文原样；`markdown`/`mdx` 才解析相应的静态结构。

## Relation records

`memory_relations` 的正式记录包含 `id`、`from`、`to`、`kind`、`origin`、`confidence`、
`weight`、`evidence`、`provenance`、`sourceRevision`、`algorithmVersion`、span/anchor、
`status` 和 `active`。`origin` 是 `source` 或 `derived`，status 是 `active`、`stale` 或
`rejected`。

来源关系来自文件内容或显式 relation input；derived 关系由系统在 scope 内计算。删除、
重命名或 revision 改变时，相关 source relation 会在同一 metadata transaction 中更新，
derived relation 由 generation 重新生成。

## 查询扩展

`RetrievalPlan.expansion.related` 和 `structural.relationExpansion` 控制有界关系扩展；
`maxHops`、`maxAdded` 是显式边界。新候选在 dedupe、external rerank、time decay 和
truncate 之前加入，并继续接受同一 `spaces`/document scope。

## 维护规则

- 备份调用方的 `<dataPath>/content/**/*.mdx` 和主 SQLite；
- 不手工编辑 `memory_relations` 替代公开 facade；
- 需要撤销 derived inference 时写入正式 status/active 状态并保留 evidence；
- 不把 vector indexes、tag association graph artifacts 或 propagation history 当作唯一备份；
- 旧 schema 或旧 payload 不迁移，使用新数据库和重新摄入完成 hard reset。
