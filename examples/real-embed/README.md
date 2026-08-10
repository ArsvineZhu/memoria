# real-embed：50 文件真实嵌入召回演示

这个示例使用真实的 DashScope `qwen3.7-text-embedding`，将
`data/content/recall-demo/` 下正好 50 篇标准 `.mdx` 个人知识库文档摄入
MemoryEngine。它对同一组 24 条 qrels 依次运行三种检索链：

- `baseline`：vector + BM25 hybrid 和 dedupe；
- `enhanced`（输出中也称 `local`）：EPA、residual pyramid、TagMemo V9/V10、RiverMemo、标签扩展、vector reshape、geodesic、time decay、同文件扩展、association 和 dedupe；
- `external`：只有显式传入 `--external-rerank` 才在 enhanced 之后调用 OpenAI-compatible Chat API。

每个查询都会打印 gold 路径、每种模式的 top-k、分数、相对路径、标题、标签、`source`、`associationChannel`、`associationOf`、`rerankScore`，以及 `tagExpansion`、`vectorReshape`、`geodesic`、`associatorStats`、`riverMemo`、`tagMemo`、`pyramid` 和 `epa` 的实际 trace。最后输出 Recall@1/3/5、MRR，并把可复现的完整摘要写入 `data/memoria/recall-demo/results.json`。

## 前提

在仓库根目录安装并编译：

```powershell
corepack pnpm install --frozen-lockfile
Copy-Item examples/real-embed/.env.example examples/real-embed/.env
```

编辑 `examples/real-embed/.env`，至少填写真实的 `EMBED_API_KEY`。`.env` 已被
Git 忽略，不能提交。可选环境变量如下：

| 变量                | 默认值                   | 用途                                          |
| ------------------- | ------------------------ | --------------------------------------------- |
| `EMBED_API_KEY`     | 无，必填                 | DashScope embedding key                       |
| `EMBED_MODEL`       | `qwen3.7-text-embedding` | embedding 模型                                |
| `EMBED_DIMENSION`   | `1024`                   | 向量维度                                      |
| `EMBED_API_URL`     | DashScope 默认 endpoint  | 覆盖 embedding endpoint                       |
| `EMBED_CONCURRENCY` | `4`                      | embedding 请求并发                            |
| `RERANK_API_URL`    | 无                       | `--external-rerank` 时必填的完整 Chat API URL |
| `RERANK_API_KEY`    | 无                       | `--external-rerank` 时必填                    |
| `RERANK_MODEL`      | 无                       | `--external-rerank` 时必填                    |
| `RERANK_TIMEOUT_MS` | `30000`                  | 外部 reranker 超时                            |

## 运行

推荐使用根脚本。`--reset` 只删除并重建固定的
`data/memoria/recall-demo/` 运行时目录；源码语料不会被删除：

```powershell
corepack pnpm demo:real-embed -- --reset --limit 50 --top-k 5
```

第一次运行会为 50 篇文档生成正文和标签 embedding，可能需要较长时间并产生
DashScope 费用。之后重新运行会复用 SQLite、向量索引和 checksum；查询 embedding
还会在 baseline/local/external 三种模式之间使用进程内 cache，避免同一查询重复调用。

小规模 smoke test 可以使用 `--limit 1..50`，例如：

```powershell
corepack pnpm demo:real-embed -- --reset --limit 3 --top-k 3
```

交互查询只运行一条查询，不计算 qrels 聚合：

```powershell
corepack pnpm demo:real-embed -- --query "买电脑会不会影响应急金" --top-k 5
```

## 可选外部 rerank

显式开关和三项配置齐全时，候选会以以下协议发送到 `RERANK_API_URL`：

```powershell
corepack pnpm demo:real-embed -- --external-rerank --top-k 5
```

请求是 OpenAI-compatible Chat API，system message 要求只返回
`[{"chunkId": number, "score": number}]`。最多发送 20 个候选，每个候选只包含
`chunkId`、相对路径、标题、标签和截断正文。未知 ID、重复 ID 和非法分数会被丢弃，
分数会限制到 `[0, 1]`。外部服务失败时 demo 保留 baseline/local 结果，并在
`rerankSkipped` 与 `rerankError` 中说明原因；不会打印 API key。发送正文到第三方
服务可能产生隐私风险和 API 费用，请只在允许的语料上开启。

## CLI 参数

| 参数                | 默认值                                  | 说明                                     |
| ------------------- | --------------------------------------- | ---------------------------------------- |
| `--reset`           | 关闭                                    | 删除并重建固定运行时目录                 |
| `--limit <1..50>`   | `50`                                    | smoke test 文档数                        |
| `--top-k <number>`  | `5`                                     | 每条查询输出和评估使用的候选数           |
| `--query <text>`    | 无                                      | 只运行一条查询，不计算 qrels 指标        |
| `--external-rerank` | 关闭                                    | 启用 external pipeline 和第三方 Chat API |
| `--json <path>`     | `data/memoria/recall-demo/results.json` | 覆盖结果 JSON 路径                       |

## 语料和结果

语料按 `work/`、`learning/`、`health/`、`travel/`、`finance/`、`home/`、
`relationships/`、`creative/` 分组，每篇都使用 YAML front matter。`.mdx` 的
front matter 会作为 metadata 和 tags 保存，正文才参与 chunk/embedding；raw 源文件
SHA-256 作为 revision，所以仅修改标签也能被检测。qrels 定义在
`examples/real-embed/recall-cases.ts`，结构测试确保默认 inventory 正好 50 篇。

运行时的 SQLite、`.usearch`、River state 和 `results.json` 都位于
`data/memoria/recall-demo/`，已被 Git 忽略，不要提交。现有离线三文件 demo 和
`tests/fixtures/real-docs/*.md` 实时夹具不受本示例影响。

能力开关、依赖、跳过条件和每个结果字段的 canonical 说明见
[检索能力矩阵](../../docs/RETRIEVAL_FEATURES.md)。
