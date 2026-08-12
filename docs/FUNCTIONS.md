# 功能行为

本文说明实现中稳定且可观察的行为；符号和参数以 [API.md](API.md)、`src/types.ts`、
`src/config/default-config.ts` 及测试为准。

## 1. MemoryEngine 生命周期

`createMemoryEngine(options?)` 只构造对象，不打开 SQLite 或 native index。
`initialize()` 完成 canonical SQLite schema 检查、provider/store wiring、恢复或重建
derived vector indexes，并将引擎置为 `ready`。初始化失败不会伪造 ready 状态。

`ingest()`/`ingestBatch()` 面向逻辑文档；`flushBatch()` 面向 filesystem adapter 提供的
文件快照。写入顺序是 metadata authority → vector indexes → scheduled save。删除通过
`remove()`、`removeBatch()` 或文件快照删除路径执行，并保持孤儿 chunk/tag 清理。

`close()` 等待 mutation queue、刷新索引保存、关闭 metadata store；重复 close 是安全的，
保存失败会保留错误并阻止错误地标记 clean。

## 2. 文件和空间

`memoria/adapters/filesystem` 只负责扫描、读取和报告变更。文件快照使用 `space` 标识
检索空间；`MemoryEngine` 负责实际摄入。front matter 的 `tags`、metadata、revision 和
正文 chunk 行为见 [GUIDE.md](GUIDE.md)。

搜索使用 `SearchOptions.spaces` 或 `RetrievalPlan.filters.spaces` 限制范围。统计和
metadata API 使用 `getDistinctSpaces()` 与 `spaces` 字段。

## 3. 检索阶段

canonical 阶段按计划加入：

1. semantic vector/BM25 candidate retrieval；
2. tag basis projection；
3. tag residual decomposition；
4. activation propagation；
5. graph diffusion；
6. propagation history；
7. propagation support rerank；
8. propagation structure rerank；
9. tag expansion、relation expansion、embedding rerank 和 external rerank；
10. time decay、dedupe、truncate 和 result formatting。

`tagGraphPropagationEnabled` 控制 activation propagation/graph diffusion 链；
`propagationHistoryEnabled` 是独立 gate。每个 stage 只在输入、scope、依赖和对应 gate
均满足时产生输出；否则返回明确的 `*Skipped` 或 failure 字段。

## 4. 结果格式

`ResultFormatterStage` 通过 chunk/file metadata hydrate 结果，并保留
`tagMatchScore`、`similarity`、`updatedAt`、`mtime`、`matchedTags`、`decay`、
`associationChannel`、`associationOf` 和 `rerankScore` 等正式字段。最终信封包含
`results` 与 `resultCount`，并可带 `retrievalDecision`、`retrievalTrace`、各阶段诊断
和统计。

## 5. Native runtime

文件型 SQLite 且 `nativeTagRetrievalEnabled=true` 时，内部 backend resolution 获取
`VexusIndex` 所有者的 tag-retrieval runtime。artifact rebuild、query observation、
activation propagation、support rerank 和 structure rerank 共享一个 artifact signature
与查询观测。runtime 缺失、输入维度错误或返回 payload 无效时只设置诊断并继续明确的
TS 阶段语义；不会调用旧 ABI 或把失败标记为成功。

## 6. Relations 和 postprocess

`memory_relations` 保存显式/派生关系及其状态。relation expansion 在 scope 内有界增加
候选，然后统一进入 dedupe、external rerank、time decay 和 truncate。`postprocess`
计划区段只控制这些正式后处理，不会改变底层 persistence schema。

## 7. TDB

`TDBEngine`、`TDBStore` 和 `TriviumDBAdapter` 是独立的 TDB library 入口，拥有独立路径、
schema、sync 和 search contracts。它们不共享主 MemoryEngine 的公开 retrieval plan。
