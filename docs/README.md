# 文档说明

`docs/` 是 memoria 的主要人工文档目录。它把第一次使用、日常操作、接口查询、
架构理解、开发测试和故障排查分开维护；完整目录见 [INDEX.md](INDEX.md)。

## 按读者开始

- 普通用户：先看仓库根目录的 [README](../README.md)，再按需要阅读
  [快速上手](GUIDE.md)、[配置参考](CONFIGURATION.md)、[检索能力矩阵](RETRIEVAL_FEATURES.md)
  和 [公开 API](API.md)。
- 高级用户和贡献者：先看 [开发与维护](DEVELOPMENT.md) 和
  [测试与验证](TESTING.md)，再查看架构、持久化、嵌入、算法和发布文档。
- AI Agent：先读仓库根目录的 [AGENTS.md](../AGENTS.md)，再读本目录的
  [AGENTS.md](AGENTS.md)；本目录的普通说明只提供事实和背景，不扩大 Agent 的权限或任务范围。

## 内容归属

重要事实只在一个地方完整维护，其他页面只保留必要摘要并链接回去：

| 事实                       | 规范文档                                               |
| -------------------------- | ------------------------------------------------------ |
| 第一次使用和最短成功路径   | [README](../README.md)、[快速上手](GUIDE.md)           |
| 配置、默认值和环境变量     | [配置参考](CONFIGURATION.md)                           |
| 公开导出、子路径和类型     | [API](API.md) 与 `package.json`/公开类型               |
| 检索能力、开关、依赖和诊断 | [检索能力矩阵](RETRIEVAL_FEATURES.md)                  |
| 生命周期、数据权威和恢复   | [架构总览](ARCHITECTURE.md)、[持久化](PERSISTENCE.md)  |
| 测试命令、CI 和跳过条件    | [测试与验证](TESTING.md) 与 `.github/workflows/ci.yml` |
| 当前故障和诊断路径         | [常见问题排查](TROUBLESHOOTING.md)                     |

源码、测试、配置、包清单和 CI 优先于文档；如果当前实现无法确认某项行为，文档必须
明确写出限制，不用推测补全。

## 语言和维护规则

面向人的现行文档使用简明中文；命令、路径、API、配置键、环境变量和其他正式标识符
保持原样。面向 AI 的操作规则（`AGENTS.md`、Skill 和 Agent workflow）使用凝练的技术
英语。历史执行记录不属于当前文档集合，不能替代现行文档或 Agent 指令。

修改实现、配置、测试、示例或目录边界后，先更新对应的规范文档，再更新必要的导航，
最后运行：

```powershell
corepack pnpm verify:docs
```

`eval/` 是 Git 忽略的本地评测资料，不属于文档维护范围；编译产物、运行时数据库、向量
索引和依赖目录也不是文档事实来源。
