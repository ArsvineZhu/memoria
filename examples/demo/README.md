# memoria CLI 章节演示

这是 memoria 的命令行章节演示，共 6 个章节，覆盖记忆库完整生命周期：

1. **初始化** —— `createMemoryEngine` + 注入 Fake 嵌入 Provider
2. **摄入** —— 写 3 篇演示日记 → `flushBatch` → `getStats`
3. **基础检索** —— 混合检索（向量 + BM25）展示格式化结果
4. **高级检索** —— TagMemo 浪潮 + EPA 投影 + 残差金字塔痕迹
5. **删除** —— `handleDelete` → 再查询确认消失
6. **收尾** —— `close()` 关闭引擎

## 运行

```bash
node main.js
# 或 npm start
```

零网络、零 API Key，一键运行、结果可复现 —— 运行前提：仓库根已完成 `npm install` 且 `rust-vexus-lite` 预编译二进制就位（随仓库分发）。

## 文件说明

| 文件 | 作用 |
|------|------|
| `main.js` | 章节式演示主脚本，`require('../..')` 引用仓库根的 memoria 入口 |
| `fake-embedding.js` | 离线确定性伪嵌入（128 维），与 `EmbeddingProvider` 接口兼容 |
| `demo-data/` | 运行期自动生成的演示数据（日记、SQLite、向量索引），已被 `.gitignore` 排除，无需提交 |

## 目录结构

```text
examples/demo/
|- main.js            # 演示主流程（6 章节）
|- fake-embedding.js  # 离线确定性嵌入 Provider
`- demo-data/         # 自动生成：notes/ 演示日记 + indices/ + memory.sqlite
```