# Memoria 50 文件真实嵌入召回 Demo 设计

## 目标

重写 `examples/real-embed`，让它直接读取标准的
`data/content/recall-demo/**/*.mdx`，使用真实 embedding 完成 50 篇混合个人知识库
文档的摄入和召回评估，并把当前检索链中的重排、标签扩展、TagMemo、RiverMemo、
同文件扩展和 Associator 等能力以可读诊断输出暴露出来。

## 数据与状态边界

- 50 篇可审查的 `.mdx` 源文件位于 `data/content/recall-demo/`，按工作、学习、健康、
  旅行、财务、家庭和创作等主题目录组织。
- 每篇文件使用 YAML front matter，至少包含 `title`、`tags`、`recordedAt`、`source`
  和 `status`；正文只作为普通文本读取和嵌入，MDX/JSX 不执行。
- SQLite、Vexus 索引和运行结果位于 `data/memoria/recall-demo/`，不提交到 Git。
- `tests/fixtures/real-docs/*.md` 保留给现有实时集成测试；demo 不再复制或依赖它们。
- 不读取、修改或索引 `eval/`。

## Embedding 与检索模式

默认使用 DashScope `qwen3.7-text-embedding`、1024 维，配置从
`examples/real-embed/.env` 读取；`EMBED_MODEL`、`EMBED_DIMENSION` 和
`EMBED_API_URL` 可覆盖默认值。

Demo 对同一批查询运行三种模式：

1. `baseline`：vector + BM25 + dedupe；
2. `enhanced`：开启 EPA、残差金字塔、TagMemo V9/V10、RiverMemo、标签扩展、向量
   相似度重排、geodesic 重排、time decay、同文件扩展和 Associator；
3. `external`：在 `enhanced` 基础上显式启用 `ExternalReranker`。

三种模式共享查询 embedding cache，但各自使用独立的内存 `RiverStateStore`，避免
RiverMemo 的跨模式状态污染；SQLite 和向量索引仍使用持久化状态目录。

## 查询评估

提交 24 条带 qrels 的查询，覆盖 direct、paraphrase、cross-topic、multi-hop 和 fuzzy
五类场景。每条案例包含稳定 ID、查询文本和相对于语料根目录的 gold 路径集合。

评估输出 `Recall@1`、`Recall@3`、`Recall@5`、MRR、每条查询的首个相关排名，以及
各阶段实际产生的统计：`tagExpansion`、`vectorReshape`、`geodesic`、
`associatorStats`、`tagMemo`、`riverMemo` 和 external rerank 状态。

## 外部 reranker

外部 reranker 使用 OpenAI-compatible Chat API，不新增第三方依赖。只有传入
`--external-rerank` 时才要求并使用 `RERANK_API_URL`、`RERANK_API_KEY` 和
`RERANK_MODEL`。

请求发送最多 20 个候选的 `chunkId`、相对路径、标题、标签和截断正文；模型必须返回
仅包含 `{chunkId, score}` 的 JSON 数组。客户端过滤未知 ID、重复 ID、非有限分数和
非法响应。HTTP 错误、超时或解析失败时保留原排序并将该模式标记为 skipped，不把
外部失败报告为召回成功。

## 能力暴露

不新增运行时 `getCapabilities()` API，也不公开所有内部 Stage 构造器。通过以下方式
改善外部可发现性：

- 在 `docs/RETRIEVAL_FEATURES.md` 维护“能力、配置开关、默认值、依赖、诊断字段、
  demo 场景”矩阵；
- 更新 API、配置、指南、示例和故障排查文档中的旧 demo 描述；
- 从根入口补齐 `ExternalReranker` 和搜索诊断数据类型的导出；
- 让 demo 在运行时打印“配置开启”与“实际产生信号”的区别。

## 验证边界

- 默认自动化测试不访问网络；外部 reranker 使用 mock `fetch` 测试。
- 真实验收使用 `corepack pnpm demo:real-embed -- --reset --limit 50 --top-k 5`；
  外部 rerank 另行使用 `--external-rerank` 验证。
- 不提交 `.env`、SQLite、`.usearch`、结果 JSON 或其他生成状态。
