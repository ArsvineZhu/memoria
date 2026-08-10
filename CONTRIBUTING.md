# 参与开发

本项目由 TypeScript 主包和 Rust N-API 原生子包组成。行为以源码和测试为准，
文档只描述已经核实的行为。

## 开始前

```powershell
git status --short --branch
corepack pnpm install --frozen-lockfile
```

先读 [INDEX.md](INDEX.md)、[AGENTS.md](AGENTS.md)，再读与任务相关的源码、测试、
示例和包配置。不要修改 `eval/`；它是 Git 忽略的本地评测资料。不要提交
`dist/`、`dist-test/`、SQLite 文件、向量索引、`.env` 或其他生成内容。

## 修改流程

1. 找到定义行为的源码和应该维护的唯一文档。
2. 只修改完成任务所需的源码、测试、示例和文档。
3. 用 `src/index.ts` 与 `package.json` 核对公开导出和类型。
4. 修改原生部分时，遵守 [rust-vexus-lite/AGENTS.md](rust-vexus-lite/AGENTS.md)。
5. 密钥只放在本地 `.env`；实时嵌入测试和真实嵌入示例只有在运行时才需要
   `EMBED_API_KEY`。

## 提交前检查

在仓库根目录运行：

```powershell
corepack pnpm verify:docs
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm typecheck:public
corepack pnpm test
corepack pnpm verify:public
corepack pnpm verify:pack
git diff --check
```

每个命令的作用、实时密钥和原生平台限制见
[docs/TESTING.md](docs/TESTING.md)。源码边界和扩展方式见
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)；发布前检查见
[docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md)。
