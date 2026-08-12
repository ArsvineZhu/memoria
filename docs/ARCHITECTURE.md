# 架构

`memoria` 分成公开入口、MemoryEngine、内部 pipeline/stage、持久化 provider、可选
Rust/N-API acceleration 和独立 TDB library。实现以源码、类型、测试和 CI 为准。

## 边界

```text
root runtime API
  ├─ createMemoryEngine / MemoryEngine
  ├─ QueryBuilder
  └─ TDBEngine / TDBStore / TriviumDBAdapter

MemoryEngine
  ├─ logical document API
  ├─ filesystem snapshot API
  ├─ SearchPipeline
  ├─ SqliteMetadataStore
  └─ VexusVectorStore

SearchPipeline
  ├─ scope + embedding + vector/BM25 retrieval
  ├─ tag-retrieval stages
  ├─ relation/tag expansion
  ├─ external rerank / time decay / dedupe / truncate
  └─ result formatter
```

`src/pipelines/`、`src/stages/`、`src/algorithms/`、`src/native/` 和内部 helper 不属于
根 runtime export。`memoria/adapters/filesystem` 与 `memoria/errors` 保持独立 subpath。

## 生命周期

1. `createMemoryEngine()` 校验 options/config 并冻结默认 retrieval plan。
2. `initialize()` 创建或验证 canonical SQLite schema，解析 provider/store，恢复或重建
   derived vector indexes。
3. `ingest`/`flushBatch` 进入 mutation queue，先写 SQLite authority，再写 vector indexes，
   最后调度持久化。
4. `search` 生成 query vector，按计划执行 stages，写入结果和稳定 retrieval diagnostics。
5. `close` drain queue、刷新索引并关闭资源；任何未恢复的 persistence/vector failure
   都会阻止错误的 ready/clean 状态。

## RetrievalPlan 到 stage

```text
strategy
  ├─ semantic       → vector/BM25
  ├─ associative    → basis → residual → activation → diffusion → support
  └─ structural     → associative 基础 → history → structure → relations

independent sections
  ├─ filters
  ├─ externalRerank
  ├─ expansion
  ├─ propagationHistory
  └─ postprocess
```

`Activation Propagation → Graph Diffusion` 是固定连续阶段。一次 query 只解析一次
`ResolvedSearchExecution`，记录 authority generation；native artifact maintenance 在
exclusive phase 中完成，再直接提升到 stable read。native stage 只消费预构建 artifact，
不会在 pipeline read 内写入 derived state。TS stages 负责明确的 fail-closed 结果和诊断。

## 依赖注入

正式注入 contracts 是 `EmbeddingProviderContract`、`VectorStoreContract`、
`MetadataStoreContract` 和 `ExternalReranker`。应用通过 `MemoryEngineOptions` 提供它们；
reranker 只在 retrieval plan 的 `externalRerank.enabled` 打开时执行，默认不访问网络；
不能通过开放式 options 注入 pipeline context、native index 或内部 planner helper。

## 数据权威

- 源文件：调用方管理的 `<dataPath>/content/**/*.mdx` 等用户文件；各 example 的源文件
  位于各自的 `data/content/`；
- SQLite：canonical files/chunks/tags/relations 和 generation authority；
- vector index：从 SQLite 重建的 derived state；
- tag graph artifacts：由 canonical authority 管理，可从 authority 重建；
- Propagation History：由 relational tables 保存的 persistent adaptive state，备份缺失时只能 reset；
- TDB：独立 library 和独立数据目录。

旧 SQLite 不迁移。schema、列或 `user_version` 不匹配时抛 persistence error，并要求
重新创建数据库；不会自动删除用户文件，也不会双写旧字段。

## Native ownership

`VexusIndex` 保留基础 vector index API。tag-retrieval runtime 由拥有 tag index 的
`VexusIndex` 实例持有，内部 facade 只暴露 canonical ABI。生成的 `index.js`、
`index.d.ts` 和平台 `.node` 必须由 N-API build 产生，不能手工伪造。
