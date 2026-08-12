# 故障排查

## Provider 配置

如果启动显示 fake，先检查 EMBED_API_URL、EMBED_API_KEY、EMBED_MODEL 和 EMBED_DIMENSION 是否完整。partial 配置按 fake 处理；这是教程行为，不是库 fallback。

如果已经显示兼容协议 provider，后续 HTTP、网络、超时或响应解析错误会直接失败。检查 endpoint 是否返回预期的 embedding 或 JSON score response，并确认 vector dimension 与 engine config 一致。

## Reranker 不执行

同时确认：

1. MemoryEngineOptions.reranker 已注入；
2. externalRerankEnabled 为 true；
3. per-query plan 的 externalRerank.enabled 没有关闭；
4. candidate 数量没有在 reranker 前被截断为空。

## SQLite schema 错误

MemoriaError("persistence") 且提示重新创建数据库时，不要添加旧字段或手动 ALTER TABLE。将旧目录移出工作路径，使用新数据库和当前 source 重新摄入。

## Dimension 错误

embedding provider 的 getDimension()、MemoryConfig.dimension、vector store 和已有 index 必须一致。改变维度后应使用新的 runtime 目录。

## Native 错误

native retrieval 依赖当前平台对应的 binary 和 canonical ABI。先运行 native tests，再判断是平台 binary 缺失还是阶段本身不可用。教程代码不直接操作 native runtime handle。

## 结果质量

fake provider 只验证调用链、结果 envelope、阶段顺序和生命周期。它不能证明 semantic recall、reranking quality 或算法优劣。质量评估必须使用配置的兼容 provider、固定语料和明确指标。
