# 测试目录

`tests/` 保存 memoria 的行为、恢复、原生、消费者和类型边界测试。测试源码先由
`corepack pnpm build:test` 编译到 `dist-test/`，再由 Node.js `node:test` 执行；完整
命令和 CI 对照见 [docs/TESTING.md](../docs/TESTING.md)。

## 主要范围

- `engine/`、`core/`、`pipelines/`、`stages/`：引擎生命周期和管线行为；
- `providers/`、`native/`：Provider、SQLite 和 Rust 原生边界；
- `integration/`：文件布局、provider 集成和跨模块行为；
- `consumer/`、`types/`：公开导出和消费者类型契约；
- `fixtures/`：测试输入资料，不是生产数据，也不属于文档入口。

缺少完整配置时，OpenAI-compatible live 用例会明确跳过；这与其他测试失败不同。修改公开
接口、配置、持久化或示例后，先定位对应测试，再按 [贡献指南](../CONTRIBUTING.md)
执行根目录验证。
