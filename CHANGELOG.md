# Changelog

## Unreleased

## 0.2.0 (2026-08-13)

- 完成 canonical naming hard reset：根运行时只保留
  `createMemoryEngine`、`MemoryEngine`、`QueryBuilder`、`TDBEngine`、`TDBStore` 和
  `TriviumDBAdapter`，ESM/CJS 与 public declarations 保持 exact parity。
- 固定 `auto`、`semantic`、`associative`、`structural` 四种 retrieval strategy，收紧
  `RetrievalPlan`、`QueryBuilder`、config 和 public type boundaries。
- 将 basis、residual、activation propagation、graph diffusion、propagation history、
  support rerank 和 structure rerank 统一到 canonical stage/layout；
  `Activation Propagation → Graph Diffusion` 成为连续阶段。
- 固定 SQLite table/column contract、`user_version = 1`、`files.space`、`tag_vectors`
  和 canonical payload schemas。非空不匹配数据库只抛 persistence error，要求新建库；
  不执行 migration、自动删除或双写。
- 固定 Rust/N-API tag-retrieval ABI，重新生成 loader、declarations 和当前平台 binary；
  未构建的平台 binary 必须在发布验收中单独标记未验证。
- 删除旧 adapter、旧配置 loader、旧 retrieval naming 和旧 native forwarding path；
  filesystem adapter 与 TDB 正式 subpath 保留。
- package identity 迁移为 `@arsvinezhu/memoria`，通过 GitHub Packages 发布；公开
  subpath 改为 `@arsvinezhu/memoria/...`，ESM/CJS exports 结构保持不变。
- 升级提示：安装名、根 import 和公开 subpath import 都必须改用
  `@arsvinezhu/memoria`；GitHub Packages 安装需要具备 `read:packages` 的 GitHub
  classic PAT，运行时 API 和 exports/subpaths 不变。
- 发布前必须重新创建 SQLite、vector indexes、tag association graph artifacts 和 propagation history；
  本版本发布包与 GitHub Release 使用同一个已审计 tarball。

## 0.1.0 (2026-08-08)

首个独立发布：

- MemoryEngine 生命周期、logical document ingestion、文件 snapshot ingestion、搜索、
  删除和结构化 MemoriaError；
- vector + BM25 hybrid retrieval、tag basis/residual analysis、tag association graph retrieval、
  relation expansion、dedupe、time decay 和 external rerank；
- TDB library：`TDBEngine`、`TDBStore`、`TriviumDBAdapter` 与独立数据目录；
- SQLite metadata authority、Rust N-API vector indexes、embedding providers 和恢复检查。
