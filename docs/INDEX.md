# 文档目录

本目录是面向人的文档。文档体系说明见 [README.md](README.md)，仓库范围内的 AI Agent 规则在
[../AGENTS.md](../AGENTS.md)，参与开发的入口在
[../CONTRIBUTING.md](../CONTRIBUTING.md)。本页只负责导航，不重复整篇内容。

## 按任务查找

| 任务                              | 统一入口                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| 安装并运行最小示例                | [GUIDE.md](GUIDE.md)                                                               |
| 配置路径、模型、检索和 TDB        | [CONFIGURATION.md](CONFIGURATION.md)                                               |
| 使用公开软件包接口                | [API.md](API.md)                                                                   |
| 查检索能力、开关、依赖和诊断字段  | [RETRIEVAL_FEATURES.md](RETRIEVAL_FEATURES.md)                                     |
| 选择 canonical 检索策略和关系图   | [RETRIEVAL_STRATEGIES.md](RETRIEVAL_STRATEGIES.md)                                 |
| 维护关系图和不可变文件源          | [RELATIONS.md](RELATIONS.md)                                                       |
| 配置类型化检索计划                | [RETRIEVAL_PLAN.md](RETRIEVAL_PLAN.md)                                             |
| 理解生命周期和管线                | [ARCHITECTURE.md](ARCHITECTURE.md)                                                 |
| 理解功能行为和选项                | [FUNCTIONS.md](FUNCTIONS.md)                                                       |
| 理解嵌入和维度要求                | [EMBEDDING.md](EMBEDDING.md)                                                       |
| 理解 SQLite、原生索引、恢复和备份 | [PERSISTENCE.md](PERSISTENCE.md)                                                   |
| 理解算法                          | [ALGORITHMS.md](ALGORITHMS.md)                                                     |
| 运行本地测试和 CI 检查            | [TESTING.md](TESTING.md)                                                           |
| 扩展或维护源码和文档              | [DEVELOPMENT.md](DEVELOPMENT.md)、[../CONTRIBUTING.md](../CONTRIBUTING.md)         |
| 发布软件包                        | [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md)、[NATIVE-MATRIX.md](NATIVE-MATRIX.md) |
| 排查运行、依赖或打包故障          | [TROUBLESHOOTING.md](TROUBLESHOOTING.md)                                           |
| 查看版本变更                      | [../CHANGELOG.md](../CHANGELOG.md)                                                 |
| 了解文档维护规则                  | [README.md](README.md)、[AGENTS.md](AGENTS.md)                                     |

## 数据、示例和测试

- [教程目录](../tutorials/README.md)：从入门到 API、配置、算法和 provider 的完整可运行说明。
- [测试目录](../tests/README.md)：测试分区、夹具边界和单测入口。
- [原生向量包说明](../rust-vexus-lite/README.md)：Rust/N-API 包的本地构建和集成边界。
- [仓库脚本](../scripts/README.md)：文档链接检查和打包消费者检查。

## 按读者查找

### 普通用户

从 [../README.md](../README.md) 开始，再读 [GUIDE.md](GUIDE.md)、
[CONFIGURATION.md](CONFIGURATION.md) 和 [API.md](API.md)。文件源和生成状态的
数据边界和运行约定见 [../tutorials/README.md](../tutorials/README.md)。

### 高级用户和贡献者

先读 [../CONTRIBUTING.md](../CONTRIBUTING.md)、[DEVELOPMENT.md](DEVELOPMENT.md)
和 [TESTING.md](TESTING.md)。修改生命周期、存储、恢复或检索管线前，先读
[ARCHITECTURE.md](ARCHITECTURE.md) 和 [PERSISTENCE.md](PERSISTENCE.md)。

### AI Agent

先读 [../AGENTS.md](../AGENTS.md)，再用本页查找事实资料。普通人的说明不能
扩大 Agent 的任务范围；修改 `rust-vexus-lite/` 时还要读其
[../rust-vexus-lite/AGENTS.md](../rust-vexus-lite/AGENTS.md)。

## 内容归属

- `README.md`：项目介绍、最短上手路径和高层导航。
- `GUIDE.md`：第一次接入和最小生命周期示例。
- `CONFIGURATION.md`：完整配置和环境变量说明。
- `API.md`：公开导出、子路径、方法、返回信封和类型。
- `RETRIEVAL_FEATURES.md`：检索增强能力矩阵、实际信号、外部 rerank 契约和教程入口。
- `RETRIEVAL_STRATEGIES.md`：自动/显式 canonical 策略、tag retrieval、关系图和 scope。
- `RELATIONS.md`：不可变 MDX 文件源、关系记录、派生关系生命周期和 scope 安全。
- `RETRIEVAL_PLAN.md`：`RetrievalPlan` 字段、策略组合、自动选择和原生降级契约。
- `ARCHITECTURE.md`：系统边界、生命周期和管线顺序。
- `FUNCTIONS.md`：功能行为和选项语义。
- `PERSISTENCE.md`：数据权威、生成状态、恢复和备份。
- `TESTING.md`：命令、CI 覆盖、跳过条件和验证解释。
- `DEVELOPMENT.md`：源码布局、扩展点和文档维护方法。
- `ALGORITHMS.md`、`EMBEDDING.md`：算法和嵌入 Provider 参考。
- `NATIVE-MATRIX.md`、`RELEASE-CHECKLIST.md`：原生分发和发布检查。
- `CHANGELOG.md`：版本历史和未发布变更。

## 工作流记录

`superpowers/` 保存技术英语设计和执行记录，仅用于审计和上下文，不是当前操作指令。
当前 Agent 规则以仓库根目录的 `AGENTS.md` 及最近的嵌套指令文件为准，记录中的
方案和清单不能覆盖实际代码、测试或 CI 状态。详见
[superpowers/README.md](superpowers/README.md) 和
[superpowers/AGENTS.md](superpowers/AGENTS.md)。

## 范围说明

本项目没有项目内的 `SKILL.md` 或 `Skills/` 目录；系统级技能不复制到这里。
`eval/` 是 Git 忽略的本地评测资料，不属于维护文档集合。
