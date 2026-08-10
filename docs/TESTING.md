# 测试与验证

所有命令都从仓库根目录运行。项目使用 Node.js 内置的 `node:test`；TypeScript
测试源码会先编译到 `dist-test/`，再执行编译后的 JavaScript。

## 前置条件

- Node.js `>=24.18.1 <25`，与 `package.json` 的引擎范围一致。
- Corepack 和 `package.json` 指定的 pnpm `11.20.0`。
- 使用锁文件安装：`corepack pnpm install --frozen-lockfile`。
- 当前平台所需的 `rust-vexus-lite` 原生二进制；可以使用仓库已有产物，也可以
  按 [NATIVE-MATRIX.md](NATIVE-MATRIX.md) 的说明本地构建。

## 命令清单

| 命令                             | 能确认什么                                        |
| -------------------------------- | ------------------------------------------------- |
| `corepack pnpm format:check`     | Prettier 格式检查通过                             |
| `corepack pnpm lint`             | Oxlint 检查 `src`、`tests`、`examples`、`scripts` |
| `corepack pnpm typecheck`        | 严格 TypeScript 类型检查通过                      |
| `corepack pnpm build`            | 生产源码、声明文件和运行产物可以编译              |
| `corepack pnpm build:test`       | 测试和示例可以编译到 `dist-test/`                 |
| `corepack pnpm test`             | 编译生产/测试源码并运行项目测试组                 |
| `corepack pnpm test:native`      | 原生加载和向量存储冒烟测试                        |
| `corepack pnpm typecheck:public` | 公开声明文件的消费者边界                          |
| `corepack pnpm verify:public`    | 公开类型检查和原生测试                            |
| `corepack pnpm verify:pack`      | 打包后的消费者冒烟测试                            |
| `corepack pnpm verify:docs`      | 维护范围内 Markdown 相对链接检查                  |
| `git diff --check`               | 检查待提交差异中的空白和冲突标记                  |

需要运行单个测试时，先编译，再直接执行对应的编译文件：

```powershell
corepack pnpm build:test
node --test dist-test/tests/utils/test-mdx-document.test.js
```

把示例路径替换为 `dist-test/` 下实际存在的测试文件。

## CI 对照

CI 的唯一依据是 `.github/workflows/ci.yml`。阻塞合并的任务包括文档链接与软件包检查、
Rust 格式/测试/构建，以及 Ubuntu 和 Windows 的原生冒烟测试。Rust Clippy
任务和 Node 26 实验任务设置了 `continue-on-error: true`，目前不是阻塞项。

## 真实嵌入测试

`tests/integration/real-dashscope.test.ts` 从仓库根目录 `.env` 读取
`EMBED_API_KEY`。没有密钥时，实时用例会明确跳过；这不是断言失败。提供密钥
后，它才会访问真实模型并测试 DashScope、持久化等路径。不要提交 `.env`。

离线演示使用 `FakeEmbeddingProvider`，不需要网络或密钥。真实嵌入演示使用
自己的 `.env`，具体见 [../examples/real-embed/README.md](../examples/real-embed/README.md)。

## 如何报告不完整验证

如果缺少原生二进制、Rust 工具链、实时密钥、网络或目标平台产物，应报告具体
命令和限制。TypeScript 构建成功不能证明原生冒烟、真实嵌入或其他平台行为成功。
