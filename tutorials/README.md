# Memoria 教程与完整手册

这里是 `memoria` 的唯一示例、教程、参考和算法说明入口。每章都有可直接运行的 `main.ts`；章节使用共享的只读 MDX 语料，运行时数据库和 vector index 始终写入该章节自己的 `data/runtime/`。

## 推荐学习路径

1. [第一次创建 MemoryEngine](01-first-memory/README.md)：完成初始化、摄入、搜索、删除和关闭。
2. [MDX 与 filesystem adapter](02-mdx-filesystem/README.md)：理解 front matter、space、scan、sync 和删除。
3. [搜索与作用域](03-search-and-scope/README.md)：理解 vector + BM25、过滤和 object-style / chain-style。
4. [RetrievalPlan 与 QueryBuilder](04-retrieval-plans/README.md)：理解四种策略、解释信息和 trace。
5. [扩展与重排](05-expansion-and-reranking/README.md)：理解本地算法、external rerank 和后处理顺序。
6. [持久化与维护](06-persistence-and-maintenance/README.md)：理解 SQLite、vector index、reconcile 和重开。
7. [TDB 子系统](07-tdb/README.md)：理解 `TDBEngine`、`TDBStore` 和 `TriviumDBAdapter`。
8. [Provider 选择](08-provider-selection/README.md)：理解完整配置与 fake provider 的统一选择规则。

如果需要查定义而不是按章节学习，请直接阅读：

- [Public API 参考](reference/public-api.md)
- [Configuration 参考](reference/configuration.md)
- [数据与 MDX](reference/data-and-mdx.md)
- [Provider 与注入](reference/providers-and-injection.md)
- [RetrievalPlan 参考](reference/retrieval-plan.md)
- [持久化与恢复](reference/persistence-and-recovery.md)
- [TDB 参考](reference/tdb.md)
- [故障排查](reference/troubleshooting.md)
- [算法总览](algorithms/README.md)

## Provider 选择规则

教程不会区分是否联网。所有需要 embedding 或 reranker 的章节都会调用 `_support/provider-config.ts`：

- 完整的 `EMBED_API_URL`、`EMBED_API_KEY`、`EMBED_MODEL`、`EMBED_DIMENSION` 选择 OpenAI-compatible embedding provider。
- 否则使用 deterministic fake embedding。它只保证向量维度和生命周期正确，不保证召回效果。
- 完整的 `RERANK_API_URL`、`RERANK_API_KEY`、`RERANK_MODEL` 选择 OpenAI-compatible reranker。
- 否则使用 fake reranker。
- 兼容 provider 请求开始后，网络、HTTP、超时和响应解析错误不会回退到 fake。

库本身不隐式创建 fake provider，也不会把 provider 函数存进 `MemoryConfig`。调用者通过 `MemoryEngineOptions` 显式注入 provider 和 reranker。

## `.env` 配置位置

所有教程命令都从仓库根目录执行。需要使用兼容服务时，在仓库根目录运行：

```powershell
Copy-Item tutorials/08-provider-selection/.env.example tutorials/08-provider-selection/.env
```

然后编辑 `tutorials/08-provider-selection/.env`。该文件不会提交到 Git；完整变量清单见
[`.env.example`](08-provider-selection/.env.example)，它只提供变量名和空值。教程支持代码读取顺序是：进程环境变量优先，其次是这个 `.env` 文件。

例如 PowerShell 也可以只为当前进程设置变量：

```powershell
$env:EMBED_API_URL = "https://your-compatible-service/v1"
$env:EMBED_API_KEY = "replace-with-your-key"
$env:EMBED_MODEL = "your-embedding-model"
$env:EMBED_DIMENSION = "1536"
corepack pnpm tutorial:08
```

embedding 需要完整的 `EMBED_API_URL`、`EMBED_API_KEY`、`EMBED_MODEL` 和正整数 `EMBED_DIMENSION`；reranker 需要完整的 `RERANK_API_URL`、`RERANK_API_KEY` 和 `RERANK_MODEL`。任一组不完整时，该组使用 fake，不影响另一组独立选择。

## 运行约定

在仓库根目录执行：

```powershell
corepack pnpm build:test
corepack pnpm tutorial:01
```

也可以运行全部章节：

```powershell
corepack pnpm tutorials:run
```

教程源数据是 MDX，位于 [`data/content/retrieval/`](data/README.md)。教程不把数据打入 package，库消费者应使用自己的 `dataPath`。
