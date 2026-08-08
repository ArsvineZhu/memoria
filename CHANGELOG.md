# Changelog

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