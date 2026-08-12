# 项目导航

`memoria` 是一个为 AI 应用提供持久化语义记忆的 Node.js 软件包。它用
SQLite 保存正文和元数据，用 Rust 原生索引加速向量检索，并提供摄入、搜索、
删除和 TDB 冷知识库能力；旧 adapter、旧配置键和旧数据库不属于当前 contract。

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
| 查检索能力、开关和诊断字段    | [docs/RETRIEVAL_FEATURES.md](docs/RETRIEVAL_FEATURES.md)                       |
| 运行测试或理解 CI             | [docs/TESTING.md](docs/TESTING.md)                                             |
| 排查运行或打包问题            | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)                             |
| 查看版本变更                  | [CHANGELOG.md](CHANGELOG.md)                                                   |

## 目录说明

```text
src/                  TypeScript 源码和公开入口
tests/                测试、类型测试和测试资料
tutorials/            从入门到算法手册的可运行教程，入口见 tutorials/README.md
tutorials/*/data/runtime/  各教程自己的运行时目录
tutorials/data/content/    教程共用的只读 MDX 源语料
docs/                 面向人的架构、API、运维和开发文档，入口见 docs/README.md 和 docs/INDEX.md
scripts/              仓库检查和打包脚本，入口见 scripts/README.md
rust-vexus-lite/      Rust 原生向量包，入口见 rust-vexus-lite/README.md 和其专属 AGENTS.md
.github/workflows/    CI 配置
dist/, dist-test/     编译产物，不是源码，不要手工编辑
```

可点击入口：

| 范围            | 入口                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| TypeScript 源码 | [src/README.md](src/README.md)、[src/AGENTS.md](src/AGENTS.md)                                                 |
| 文档体系        | [docs/README.md](docs/README.md)、[docs/INDEX.md](docs/INDEX.md)                                               |
| 教程            | [tutorials/README.md](tutorials/README.md)                                                                     |
| 测试            | [tests/README.md](tests/README.md)                                                                             |
| 仓库脚本        | [scripts/README.md](scripts/README.md)                                                                         |
| 原生包          | [rust-vexus-lite/README.md](rust-vexus-lite/README.md)、[rust-vexus-lite/AGENTS.md](rust-vexus-lite/AGENTS.md) |

行为以源码和测试为准；软件包入口、命令、依赖和 Node.js 版本以
`package.json` 为准；CI 以 `.github/workflows/ci.yml` 为准；原生构建以
`rust-vexus-lite/` 的包配置和 Rust 源码为准。

## 数据边界

仓库不维护根 `data/` 目录，也不把数据作为库的随包内容。教程源 MDX 位于
`tutorials/data/content/retrieval/`；各教程的 `data/runtime/` 仅用于本地生成
SQLite 和向量索引，并由 `.gitignore` 排除。
库本身仍保留 `dataPath` 配置语义，由调用方决定自己的运行时目录。

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
