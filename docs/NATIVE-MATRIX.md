# 原生分发矩阵

`rust-vexus-lite/index.js` 是生成的 N-API-RS 加载器，保持 CommonJS 作用域。
TypeScript 外层只校验它返回的 `unknown`，不修改生成加载器或 Rust 导出符号。

## 当前包内的原生文件

| 平台                | 文件                               |
| ------------------- | ---------------------------------- |
| Windows x64 / MSVC  | `vexus-lite.win32-x64-msvc.node`   |
| macOS arm64         | `vexus-lite.darwin-arm64.node`     |
| Linux x64 / glibc   | `vexus-lite.linux-x64-gnu.node`    |
| Linux x64 / musl    | `vexus-lite.linux-x64-musl.node`   |
| Linux arm64 / glibc | `vexus-lite.linux-arm64-gnu.node`  |
| Linux arm64 / musl  | `vexus-lite.linux-arm64-musl.node` |

包内还带有 `vexus-lite.node` 通用产物。它来自现有 Rust 包，但不作为额外平台
选择证据。其他 loader 分支需要另外发布对应的 N-API 文件，本项目不宣称已经支持。

## 如何验证

- Windows 本地运行 `corepack pnpm test:native` 和 `corepack pnpm verify:pack`；
- Linux 和 Windows CI 在 `.github/workflows/ci.yml` 中运行原生冒烟测试；
- 打包消费者测试会从 tarball 加载 `rust-vexus-lite` 并创建 `VexusIndex`，因此发布包
  不应依赖用户本地的 Rust 工具链。

如果目标平台缺少文件，在有 Node.js、Rust stable 和对应 target 的环境中执行：

```powershell
Set-Location rust-vexus-lite
corepack pnpm exec napi build --platform --release
```

构建结果和实际发布范围必须重新对照本页，不能凭平台名称推断支持。
