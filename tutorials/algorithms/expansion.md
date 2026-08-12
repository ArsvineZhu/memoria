# Expansion：Tag、Relation 与同文档扩展

## 目标

Expansion 在初始候选之外补充相关 chunk，再让统一的 dedupe、rerank、decay 和 truncate 处理完整候选池。扩展不是排序本身。

## 三类扩展

### Tag Expansion

\`tagExpansionEnabled\` 打开后，stage 使用 tag retrieval 输出查找带有相关 tags 的 chunks。配置决定 seed 数量、每个 tag 的候选上限、boost 和允许的 scope。新增候选会标记 \`source: "tag-expansion"\` 等来源诊断。

### Relation Expansion

\`relationExpansionEnabled\` 打开后，stage 从当前候选的 relation seeds 沿显式/derived relations 走有限 hop。相关配置包括 hop、seed、max added、boost 和 scope。关系距离和置信度会影响新增候选分数。

### 同文档/关联扩展

\`expansionEnabled\`、\`fullDocumentExpansionEnabled\` 和 \`associatorEnabled\` 控制同文件 sibling、完整文档或关联 chunk 的补充。它们属于候选生产阶段，必须在 common tail 之前完成。

## 阶段与输出

\`\`\`text
base candidates
→ tag/relation/document expansion
→ dedupe
→ external rerank
→ time decay
→ truncate
\`\`\`

公开结果可以包含 expansion 的 added/boosted 统计以及 candidate source。扩展后的候选如果超出 \`spaces\`、document、metadata 等 scope，最终 filter 仍会移除它们。

## 边界

- seed 为空、scope 不匹配或 relation store 没有边时，合法输出是没有新增候选。
- 扩展上限用于防止候选池无限增长。
- 外部 reranker 只重排最终去重后的池；扩展阶段不会自己请求模型。
- 由于 fake embedding 不保证语义质量，教程中的扩展结果只用于展示流程。

源码：[tag-expander.ts](../../src/stages/tag-retrieval/tag-expander.ts)、[relation-expansion.ts](../../src/stages/postprocess/relation-expansion.ts)、[expander.ts](../../src/stages/postprocess/expander.ts)。
