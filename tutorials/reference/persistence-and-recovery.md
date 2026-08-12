# 持久化与恢复

## SQLite contract

空数据库初始化为 version 1，并要求精确的用户表和字段集合：

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
memory_relations
```

files.space 是 canonical space identity。KV 使用 canonical keys，例如 tag_basis_cache 和 propagation_history。payload version 使用 propagation-history-v1、tag-graph-artifact-v1、tag-association-transition-v1 和 tag-association-provenance-v1。

## Fail-fast policy

空库可以创建 canonical schema。非空数据库如果 user_version、table set、column set 或关键类型不匹配，会抛 MemoriaError，提示重新创建数据库。不会执行旧 schema migration、ALTER TABLE 兼容路径、双写或旧字段 fallback。

## Derived state

metadata/content 是 authority；vector index、tag vector index、graph artifact、residual metrics、pair similarities 和 propagation history 都可以依据 authority 重建。initialize() 会恢复可用 derived state，reconcile() 可以显式重建。

## Recovery checklist

1. 保留旧目录以便人工取证。
2. 创建新的 dataPath、SQLite 和 vector index 目录。
3. 使用当前 MDX/source 重新摄入。
4. 等待 initialize() 和 reconcile() 完成。
5. 读取 getStats().healthy，确认 vector dimension 和 index 数量。

库不会替调用者删除旧数据库，也不会把旧数据库自动转换成新 schema。
