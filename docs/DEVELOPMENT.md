# 开发与维护

## 源码布局

| 目录                              | 职责                                          |
| --------------------------------- | --------------------------------------------- |
| `src/index.ts`                    | ESM 公开入口和导出类型                        |
| `src/engine.ts`                   | `MemoryEngine` 生命周期、逻辑摄入、搜索和删除 |
| `src/pipelines/`、`src/stages/`   | 摄入、检索、记忆、后处理、输出和 TDB 阶段     |
| `src/providers/`                  | SQLite 元数据、Rust 向量存储和嵌入 Provider   |
| `src/interfaces/`、`src/types.ts` | Provider 契约和运行时/公开数据结构            |
| `src/compat/`                     | `KnowledgeBaseAdapter` 兼容层                 |
| `src/config/`                     | 默认配置、路径派生和 RAG 参数加载             |
| `src/utils/`                      | 文本、MDX、向量和数值工具                     |
| `tests/`                          | 单元、集成、消费者、类型和恢复测试            |
| `examples/`                       | 离线演示和真实 Provider 示例                  |
| `rust-vexus-lite/`                | 原生向量索引包，另有专属 `AGENTS.md`          |

## 扩展点

优先使用公开契约，不要直接依赖私有阶段：

- 实现 `EmbeddingProviderContract` 时提供 `embedBatch` 和 `getDimension`；
- 只有确实需要替换持久化边界时，才实现 `MetadataStoreContract` 或
  `VectorStoreContract`；
- 用 `Stage`/`Pipeline` 组合管线行为；
- 用 `FilesystemIngestionAdapter` 处理文件扫描、读取和监听；
- 保持 `MemoryEngine` 的逻辑摄入与文件系统职责分离。

修改契约前先读 [API.md](API.md)、[ARCHITECTURE.md](ARCHITECTURE.md) 和
[EMBEDDING.md](EMBEDDING.md)。

## 数据和生成内容

属于仓库的源文档放在 `data/content/`。`data/memoria/`、`data/tdb/` 下的
SQLite 和向量索引是生成内容并被忽略；`dist/`、`dist-test/` 和原生构建产物
也不是源码。`eval/` 是 Git 忽略的本地评测资料，不参与开发或文档维护。

## 文档维护流程

1. 用 [../INDEX.md](../INDEX.md) 和 [INDEX.md](INDEX.md) 确定读者与统一入口。
2. 每个事实都要回到源码、测试、示例、包配置或 CI 核实。
3. 上手步骤放在 `GUIDE.md`，完整配置放在 `CONFIGURATION.md`，公开符号放在
   `API.md`，功能行为放在 `FUNCTIONS.md`，运行策略放在持久化/测试/排障文档。
4. AI 专属规则放在 [../AGENTS.md](../AGENTS.md)，不要混入普通人的指南。
5. 新增文档或移动文档时，同步更新 `docs/INDEX.md` 和相邻交叉引用。

先运行可重复的文档检查：

```powershell
corepack pnpm verify:docs
```

该检查只验证维护范围内 Markdown 的相对路径，不检查 `eval/`、编译产物、依赖
或测试夹具。

## 原生开发

原生包使用 `@napi-rs/cli`。修改原生导出、产物名称或加载器前，先遵守
[../rust-vexus-lite/AGENTS.md](../rust-vexus-lite/AGENTS.md)，并阅读
[NATIVE-MATRIX.md](NATIVE-MATRIX.md)。
