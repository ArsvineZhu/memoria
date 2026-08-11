# memoria 离线章节演示

这是 memoria 的离线章节演示，共 6 个章节，覆盖记忆库的完整生命周期：

1. **初始化** —— `createMemoryEngine` + 注入 Fake 嵌入 Provider
2. **摄入** —— `ingestDemoSources()` 通过固定清单调用 `ingestFile()` 读取 3 篇 MDX 演示日记 → `getStats`
3. **基础检索** —— 混合检索（向量 + BM25）展示格式化结果
4. **高级检索** —— TagMemo 浪潮 + EPA 投影 + 残差金字塔痕迹
5. **删除** —— `FilesystemIngestionAdapter.removeFile()` → 再查询确认消失
6. **收尾** —— `close()` 关闭引擎

## 运行

```bash
corepack pnpm build:test
node ../../dist-test/examples/demo/main.js
```

零网络、零 API Key，一键运行、结果可复现 —— 运行前提：仓库根已完成
`corepack pnpm install --frozen-lockfile` 且 `rust-vexus-lite` 预编译二进制就位（随仓库分发）。

## 文件说明

| 文件                       | 作用                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| `main.ts`                  | TypeScript ESM 演示主脚本，导入仓库根的 memoria 入口               |
| `demo-sources.ts`          | 固定三文件清单；不扫描包含 recall benchmark 的整个 `data/content/` |
| `fake-embedding.ts`        | 离线确定性伪嵌入（128 维），与 `EmbeddingProvider` 接口兼容        |
| `../../data/content/`      | 仓库维护的 MDX 演示源文件；运行时只读取，不覆盖源文件              |
| `../../data/memoria/demo/` | 运行期生成的 SQLite、向量索引与 sidecar；已被 `.gitignore` 排除    |

## 目录结构

```text
examples/demo/
|- main.ts            # 演示主流程（6 章节）
|- demo-sources.ts    # 固定三文件摄入清单
|- fake-embedding.ts  # 离线确定性嵌入 Provider
`- （数据见仓库根 data/）

data/
├─ content/{life,memory,quantum}/*.mdx  # canonical source
└─ memoria/demo/                         # generated demo state
```

MDX front matter 中的 `tags` 会进入标签管线，其他字段进入文件 metadata；正文
才会参与分块和嵌入。演示不会递归扫描 `data/content/`、不会递归清空 `data/`，也不会执行 MDX。
