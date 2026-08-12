# TDB 参考

## TDBEngine

TDBEngine 使用 TdbEngineOptions，通过 config.tdbEnabled 开启。主要 lifecycle 是 initialize()、upsertText()、upsertFile()、removeFile()、removeText()、search()、searchWithVector()、listLibraries()、getStats()、reconcile() 和 close()。

TDB search options 使用：

```text
libraries
topK
minScore
hybridAlpha
expand
expandDepth
path
library
title
now
sourceUpdatedAt、recordedAt、indexedAt 均使用 Unix epoch milliseconds。
size
```

## TDBStore

TDBStore 是 TDB metadata contract 的 SQLite 实现。它维护 TDB 文件、chunk、vector 和 generation state。它不复用 MemoryEngine 的用户表 contract；两个 engine 的数据库路径应分开。

## TriviumDBAdapter

TriviumDBAdapter 可以注入 vector store 和 metadata store，并提供 insert/submit、delete、search、searchHybrid、flush、stats 等适配接口。没有 backend 时它保持 inert，不会偷偷创建远程服务。

## TDB 与 MemoryEngine 的区别

| 项目        | MemoryEngine            | TDBEngine                      |
| ----------- | ----------------------- | ------------------------------ |
| 作用域      | spaces                  | libraries                      |
| 主要入口    | ingest、upsert、search  | upsertText、upsertFile、search |
| 配置前缀    | 普通 MemoryConfig       | tdb*                           |
| persistence | canonical memory schema | TDB metadata schema            |

不要把 TDB library、cold-knowledge 或 TriviumDB 名称替换成 tag retrieval 的术语。
