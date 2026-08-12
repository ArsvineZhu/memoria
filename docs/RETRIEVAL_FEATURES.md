# 检索能力矩阵

本文记录 canonical retrieval gates、依赖和实际结果字段。开关打开只表示 stage 可以
加入 pipeline；空候选、空标签图、scope、维度或依赖不满足时，stage 可以安全跳过，
必须以结果 trace 判断是否真正执行。

## 三层排序模型

1. 基础排序：向量检索和 BM25 的归一化分数融合，再去重和排序；不调用 reranker 模型。
2. 本地重排：embedding cosine、propagation support 和 propagation structure 等确定性
   stage，分别由对应 gate 控制，默认关闭。
3. 模型重排：`MemoryEngineOptions.reranker` 注入的 provider，配合
   `externalRerankEnabled` 显式开启；执行顺序是 `dedupe → model rerank → time decay →
truncate`。

| 能力                       | 开关/入口                                         | 主要依赖                                 | 输出/诊断                              |
| -------------------------- | ------------------------------------------------- | ---------------------------------------- | -------------------------------------- |
| vector + BM25              | `vectorWeight`、`bm25Weight`                      | embedding、SQLite、vector store          | `vectorResults`、`bm25Results`         |
| tag basis projection       | `tagBasisProjectionEnabled`                       | tag vectors                              | `tagBasisProjection`                   |
| tag residual decomposition | `tagResidualDecompositionEnabled`                 | tag vectors                              | `tagResidualDecomposition`             |
| activation propagation     | `tagGraphPropagationEnabled`                      | tag association graph、tag vectors       | `tagGraphPropagation`                  |
| graph diffusion            | 同一 `tagGraphPropagationEnabled` gate            | activation output、graph operators       | `tagGraphPropagation` diffusion fields |
| propagation history        | `propagationHistoryEnabled`                       | `PropagationHistoryStore`                | `propagationHistory`                   |
| support rerank             | `propagationSupportRerankEnabled`                 | activation output、tag IDs               | `propagationSupport`                   |
| structure rerank           | `propagationStructureRerankEnabled`               | graph observation、candidates            | `propagationStructure`                 |
| native tag retrieval       | `nativeTagRetrievalEnabled`                       | file-backed SQLite、shipped Rust binding | `tagRetrieval*`、`tagGraphArtifact*`   |
| tag expansion              | `tagExpansionEnabled`                             | `tag_vectors`                            | `tagExpansion`                         |
| embedding rerank           | `embeddingRerankEnabled`                          | chunk vectors                            | `embeddingRerank`                      |
| relation expansion         | `relationExpansionEnabled` 或 `expansion.related` | `memory_relations`                       | relation expansion diagnostics         |
| external/model rerank      | `externalRerankEnabled` + `options.reranker`      | OpenAI-compatible Chat API provider      | `reranked`、`rerankFailure`            |
| time decay                 | `timeDecayEnabled`                                | file timestamps                          | result `decay`                         |
| dedupe/truncate            | `dedupeEnabled` / `truncateEnabled`               | candidate vectors/score                  | `dedupeStats`、`truncationStats`       |

## canonical stage order

启用 associative/structural retrieval 时，tag-retrieval 方向固定为：

```text
tag basis projection
→ tag residual decomposition
→ activation propagation
→ graph diffusion
→ propagation history
→ propagation support rerank
→ propagation structure rerank
```

`Activation Propagation → Graph Diffusion` 不允许被旧版本 section 或独立版本选择拆开。
该顺序是内部 pipeline invariant；公开结果通过 `retrieval.evidence` 表达可用 channel。

## native 语义

native runtime 只在 file-backed SQLite 和可用的 `VexusIndex` tag-retrieval runtime 上
执行。它共享 tag association graph artifact signature 和查询 observation；缺少 binding、使用
`:memory:`、维度不匹配或 payload 无效时，内部会记录具体 failure。公开结果通过稳定的
`retrieval.fallbacks` 表达降级；TS stage 仍按 canonical 排序和失败语义继续，不能把
skip 当作 native success。

## 结果字段

内部阶段结果可以包含 `tagMatchScore`、`similarity`、`matchedTags`、`decay`、
`associationChannel`、`associationOf`、`rerankScore`、`tagBasisProjection`、
`tagResidualDecomposition`、`tagGraphPropagation`、`propagationHistory`、
`propagationSupport` 和 `propagationStructure`。这些字段来自同一 SearchEnvelope，
不额外暴露内部 carrier 类型；MemoryEngine 的公开 envelope 只保留 allowlist 字段和
`retrieval` 诊断。

## Demo 和验证

provider 选择教程位于 [tutorials/08-provider-selection](../tutorials/08-provider-selection/README.md)。
没有完整 `EMBED_*` 配置时使用 fake embedding，只验证教程生命周期和输出形状；有完整
配置时才会访问 OpenAI-compatible embedding service。HTTP/build 成功或静态检查都不等于
兼容 provider 的请求约束已有测试；live 请求是否执行取决于当前环境配置。
