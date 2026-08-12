# 持久化、恢复和 hard reset

SQLite 是 MemoryEngine 的 metadata authority；Rust `VexusIndex` 文件、Rust tag association graph
artifact 和其他可重建 derived state 都可以从 authority 重建。Propagation History 是跨查询
累积的 persistent adaptive state，保存在 SQLite 中，丢失后只能 reset，不能从文档 authority
reconstruct。`eval/`、`dist/`、`dist-test/`、`target/` 和 `node_modules/` 不属于持久化源码维护范围。

## canonical SQLite schema

主用户表必须且只能是（以下 marker 由 `verify:docs` 对照 canonical schema 自动校验）：

<!-- canonical-schema:start -->

schema-version: 3
history-schema: propagation-history-v2
history-storage: relational-tables
tables:
files
chunks
tags
file_tags
tag_residual_metrics
tag_derived_artifacts
tag_pair_similarity
tag_pair_similarity_status
tag_graph_artifacts
kv_store
propagation_history_state
propagation_history_edges
memory_relations
<!-- canonical-schema:end -->

```text
files
chunks
tags
file_tags
tag_residual_metrics
tag_derived_artifacts
tag_pair_similarity
tag_pair_similarity_status
tag_graph_artifacts
kv_store
propagation_history_state
propagation_history_edges
memory_relations
```

空数据库创建完整 schema 并写入 `PRAGMA user_version = 3`。启动时同时校验
`sqlite_master` 的 exact table set 和每张表的 exact column set；非空数据库只要版本、表或
列不匹配，就抛 `MemoriaError("persistence")` 并提示重新创建数据库。不会执行
`ALTER TABLE`、additive migration、旧字段 fallback、自动删除或双写。

核心身份列是 `files.space`。metadata API 使用 `space`/`spaces`，
tag vector index 固定为 `tag_vectors`。

## 表职责

| 表                           | 职责                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `files`                      | 文件/逻辑文档身份、space、checksum、时间和 metadata                              |
| `chunks`                     | chunk 正文和 vector BLOB                                                         |
| `tags`                       | tag 名称和 vector BLOB                                                           |
| `file_tags`                  | file/tag 关联及 position                                                         |
| `tag_residual_metrics`       | tag residual metrics 的 canonical 结果                                           |
| `tag_derived_artifacts`      | basis/residual 等 derived artifact metadata                                      |
| `tag_pair_similarity`        | tag pair similarity                                                              |
| `tag_pair_similarity_status` | pair computation status                                                          |
| `tag_graph_artifacts`        | tag association graph 的 `tag-graph-artifact-v1` payload、generation 和 checksum |
| `kv_store`                   | generation、`tag_basis_cache` 等 canonical key/value payload                     |
| `propagation_history_state`  | Propagation History 的 sequence 和 total mass                                    |
| `propagation_history_edges`  | Propagation History 的 source/target edge totals                                 |
| `memory_relations`           | source/derived relation authority                                                |

payload codec/schema 固定使用 `propagation-history-v2`、`tag-graph-artifact-v1`、
`tag-association-transition-v1` 和 `tag-association-provenance-v1`。任何不匹配的旧
payload 都需要通过新数据库和新的可重建 derived artifacts 重新生成。

## 写入和恢复

写入事务先更新 `files`/`chunks`/`tags`/`file_tags`/relations，再更新 generation；
vector index 保存随后执行。引擎使用 `metadata_generation`、`vector_generation`、
`vector_dirty` 和 `relation_generation` 判断 clean restore 或 full rebuild。

恢复顺序：

1. 打开并验证 canonical SQLite；
2. 读取 authority rows 和 generation；
3. 验证 persisted vector index 的维度、文件和 native stats；
4. clean 时恢复，或从 SQLite 重建所有 expected indexes；
5. 仅在全部必要保存成功后写 `vector_dirty=0` 并进入 ready。

任何维度、文件、payload、native runtime 或保存失败都保留 dirty/error 状态；不能用空
index 或部分 add 把恢复标记为成功。旧数据库不会自动转换：应用必须显式创建新的
`dbPath`、`storePath`，重新摄入文档并重建 tag association graph/artifacts；Propagation
History 若未随 SQLite 备份保留，则只能显式 reset/reinitialize，不能从文档重新生成原有查询历史。

## Vector indexes

space index 和 `tag_vectors` 是 SQLite 的 derived cache。删除 index 文件是可恢复的维护
动作；删除 SQLite 则删除 authority。`close()` 会等待写入 queue、刷新 pending saves，
并在失败时返回 `MemoriaError("lifecycle")`。

## 关系和历史

`memory_relations` 记录显式关系、derived relation、source revision、algorithm version、
status 和 active 状态。`propagation_history_state` 与 `propagation_history_edges` 独立存储
Propagation History 的 sequence、total mass 和 edge totals；`propagation-history-v2` 是
查询结果中的 history schema，而不是 `kv_store` payload。relation generation 或 graph
generation 改变时，相关可重建 derived artifact 会重新发布；Propagation History 不会因此
从 authority 重算。

## TDB

TDB 使用自己的 library schema、数据库和 vector indexes。它保留 `TDBEngine`、`TDBStore`
和 `TriviumDBAdapter` 术语，不与主库的 canonical table contract 混用。

## 备份边界

- 备份调用方的 `<dataPath>/content/**/*.mdx` 等源文件；example 源文件只属于对应 example；
- 备份主 SQLite 以保留 metadata、relations、vectors authority 和 Propagation History；
- vector indexes 和 tag association graph artifacts 可在 canonical authority 上重建；
- Propagation History 属于需要备份的 persistent adaptive state，未备份时只能 reset；
- 不把 `eval/` 或任何编译/运行时目录纳入文档和源码维护。
