# 示例目录

`examples/` 提供两条可以直接运行的接入路径：不需要网络的离线演示，以及使用 50 篇
标准 MDX 和真实模型的嵌入召回演示。两个示例都从仓库根目录编译，编译结果放在
`dist-test/`，不会把示例自己的 `package.json` 当作独立发布包。

## 选择示例

| 目的                                   | 入口                                         | 要求                                            |
| -------------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| 先确认安装、摄入、搜索、删除和关闭流程 | [demo/README.md](demo/README.md)             | 无网络、无 API 密钥                             |
| 使用真实嵌入检查语义召回               | [real-embed/README.md](real-embed/README.md) | `examples/real-embed/.env` 中有 `EMBED_API_KEY` |

首次运行前，在仓库根目录执行：

```powershell
corepack pnpm install --frozen-lockfile
```

然后按所选示例的说明运行 `corepack pnpm build:test` 和对应的编译脚本。离线演示
适合验证本地环境；真实嵌入演示会访问 DashScope，并按 24 条 qrels 输出 baseline、
local enhanced 和可选 external rerank 三组结果。密钥缺失时不应把退出误认为本地
实现已损坏。检索阶段、开关和结果字段的完整说明见
[检索能力矩阵](../docs/RETRIEVAL_FEATURES.md)。

示例使用的公开接口和配置分别以 [API](../docs/API.md)、[配置参考](../docs/CONFIGURATION.md)
和 [嵌入 Provider](../docs/EMBEDDING.md) 为准。示例代码改变后，必须同时检查本目录
的说明和 [测试与验证](../docs/TESTING.md)。
