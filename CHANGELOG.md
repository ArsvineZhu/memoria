# Changelog

## Unreleased

- 修复 generation clean reopen 的 persisted Vexus index 注册、`indexLoadEnabled=false`
  回退，以及全量 SQLite rebuild 前的 derived-state reset，避免 stale diary index
  复活 ghost vectors；packed consumer 现在覆盖 close → reopen → vector recall。
- 收紧 search 主链的 MetadataStore persistence error boundary：查询失败现在抛出带
  `cause`、`retryable=true` 的 `MemoriaError("persistence")`，不再静默返回空结果或
  跳过 candidate；同时修复 absolute/relative file mutation key 的 canonicalization。
- 保持新增 MetadataStore capabilities optional，修复 legacy `file_id` fallback、
  skipped ingest 的 clean-state 保留，以及 SQLite close failure 的传播与重试语义。
- 同步 ARCHITECTURE/PERSISTENCE 文档，说明 constructor/deferred provider、generation
  fast path、`replaceDocumentState()` 原子写入和 close/flush failure lifecycle 规则。
- 完成原生 TypeScript 迁移：Node 24.18.1 / pnpm 11.20.0 / TypeScript 7.0.2、ES2024
  NodeNext、ESM-first `src/index.ts` → `dist/`，并保留历史 `require('memoria')` facade。
- 增加无 filesystem 依赖的 logical `ingest` / `upsert` / `ingestBatch` / `remove` API，
  以及独立 `memoria/adapters/filesystem` 文件系统 adapter。
- SQLite 文件元数据与内容 BLOB 作为权威状态，增加 revision/source/metadata 字段、
  启动 reconciliation、向量索引重建和结构化 `MemoriaError`。
- 增加数值边界校验、严格类型检查、ESM consumer、packed consumer 与双平台原生 smoke
  覆盖，README 与维护文档统一为 TypeScript/ESM/pnpm 示例。

## 0.1.0 (2026-08-08)

首个独立发布，能力继承 vcp-memory 全部积累：

- MemoryEngine 全生命周期：config merge / pipeline 初始化 / provider 注入 / 读写删
- 7 阶段检索管线（ingestion/embedding/chunking/candidate/retrieval/postprocessing/storage）
- 混合检索（向量 + BM25）、语义去重（exact/semantic）、Gram-Schmidt 向量正交化
- 记忆综合体：TagMemory 浪潮算法、RiverMemory 拓扑（scaled-field solver / 河流可见性）、
  EPA 语义分析（逻辑深度/主轴/共振）、残差金字塔
- 标签体系：自动提取、加权 PCA / SVD 聚类、标签索引
- TDB 冷知识库（TriviumDB）：独立搜索管线、TDBStore、adapter
- 持久化：SQLite 元数据 + Rust N-API 向量索引，双写盘 + 懒加载恢复
- 嵌入 Provider：OpenAI 兼容、DashScope 原生（qwen3.7-text-embedding，document/query 双模式）、测试伪嵌入
- Rust N-API 向量引擎（rust-vexus-lite）：6 平台预编译二进制内置
