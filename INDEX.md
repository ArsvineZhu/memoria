# 项目导航

`memoria` 是一个为 AI 应用提供持久化语义记忆的 Node.js 软件包。它用
SQLite 保存正文和元数据，用 Rust 原生索引加速向量检索，并提供摄入、搜索、
删除、兼容旧调用和 TDB 冷知识库能力。

## 从哪里开始

| 你的目的                      | 先看                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------ |
| 了解项目并运行最小示例        | [README.md](README.md)                                                         |
| 完成第一次接入                | [docs/GUIDE.md](docs/GUIDE.md)                                                 |
| 查找全部文档                  | [docs/INDEX.md](docs/INDEX.md)                                                 |
| 参与开发或修改项目            | [CONTRIBUTING.md](CONTRIBUTING.md)、[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| 让 AI Agent 操作本仓库        | [AGENTS.md](AGENTS.md)                                                         |
| 查公开 API 和类型             | [docs/API.md](docs/API.md)                                                     |
| 查配置、路径、模型和 TDB 参数 | [docs/CONFIGURATION.md](docs/CONFIGURATION.md)                                 |
| 运行测试或理解 CI             | [docs/TESTING.md](docs/TESTING.md)                                             |
| 排查运行或打包问题            | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)                             |
| 查看版本变更                  | [CHANGELOG.md](CHANGELOG.md)                                                   |

## 目录说明

```text
src/                  TypeScript 源码和公开入口
tests/                测试、类型测试和测试资料
examples/             离线演示和真实嵌入演示，入口见 examples/README.md
data/                 可备份的 Markdown/MDX 源文件和运行状态边界，入口见 data/README.md
data/memoria/         主引擎生成的 SQLite 和向量索引
data/tdb/             TDB 生成的 SQLite 和向量索引
docs/                 面向人的架构、API、运维和开发文档，入口见 docs/README.md 和 docs/INDEX.md
scripts/              仓库检查和打包脚本，入口见 scripts/README.md
rust-vexus-lite/      Rust 原生向量包，入口见 rust-vexus-lite/README.md 和其专属 AGENTS.md
.github/workflows/    CI 配置
dist/, dist-test/     编译产物，不是源码，不要手工编辑
```

可点击入口：

| 范围     | 入口                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| 文档体系 | [docs/README.md](docs/README.md)、[docs/INDEX.md](docs/INDEX.md)                                               |
| 数据边界 | [data/README.md](data/README.md)                                                                               |
| 示例     | [examples/README.md](examples/README.md)                                                                       |
| 测试     | [tests/README.md](tests/README.md)                                                                             |
| 仓库脚本 | [scripts/README.md](scripts/README.md)                                                                         |
| 原生包   | [rust-vexus-lite/README.md](rust-vexus-lite/README.md)、[rust-vexus-lite/AGENTS.md](rust-vexus-lite/AGENTS.md) |

行为以源码和测试为准；软件包入口、命令、依赖和 Node.js 版本以
`package.json` 为准；CI 以 `.github/workflows/ci.yml` 为准；原生构建以
`rust-vexus-lite/` 的包配置和 Rust 源码为准。

## 数据边界

文件摄入的源文件放在 `data/content/**/*.mdx`。`data/memoria/` 和
`data/tdb/` 下的 SQLite 文件、向量索引和旁车文件都是运行时生成内容，具体
规则见 [data/README.md](data/README.md)。

## 范围边界

`eval/` 是本地评测资料，已经由 Git 忽略。本次及以后文档维护不读取、不修改、
不删除它，也不把它加入任何导航。

本项目没有项目内的 `SKILL.md` 或 `Skills/` 目录。系统级技能不复制到仓库；
面向人的流程放在 `docs/`，面向 AI Agent 的仓库规则放在
[AGENTS.md](AGENTS.md)。

## 修改文档时

1. AI Agent 先读 [AGENTS.md](AGENTS.md)。
2. 先检查工作树、软件包配置、源码、测试和示例，再改文字。
3. 同一事实只在一个文档中完整维护，其他地方使用链接。
4. 修改或新增文档后，运行 [docs/TESTING.md](docs/TESTING.md) 中的检查。
