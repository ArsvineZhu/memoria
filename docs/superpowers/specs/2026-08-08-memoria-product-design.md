# memoria — 记忆库产品化设计

日期：2026-08-08 | 状态：已批准（A 方案） | 位置：`C:\dev\memoria`

## 背景与目标

把 VCPToolBox 中的 `vcp-memory` 子库从项目内脱离，建为独立产品仓库 **memoria**
（@memoria/core 语义、npm 包名 `memoria`），抛弃 VCP 冠名，补齐"完整仓库结构"
（README、LICENSE、docs、examples、CI、CHANGELOG），并提供完整功能说明。

产品定位：面向 AI 应用的可持久化语义记忆系统 —— 向量检索 + 标签浪潮 +
拓扑记忆 + 冷知识库，Node.js 核心 + Rust N-API 向量引擎。

## 决策记录

| 决策点 | 结论 |
|--------|------|
| 产品名 | memoria（拉丁语"记忆"），npm 包名 `memoria`，v0.1.0 起 |
| 仓库位置 | 新独立目录 `C:\dev\memoria`，与 VCPToolBox / vcp-memory-demo 彻底脱钩 |
| 仓库形态 | 方案 A：单包产品仓库，源码提为根，examples/ 并入 demo |
| 文档语言 | 中文为主（README/文档），代码注释保持英文 |
| License | MIT，git init + 首个提交（含预编译 Rust 二进制） |

## 目标目录结构

```
C:\dev\memoria\
├── README.md              # 中文产品入口
├── LICENSE                # MIT
├── CHANGELOG.md           # 0.1.0 首版
├── .gitignore
├── package.json           # name: memoria, v0.1.0
├── index.js               # 库导出面（不变）
├── src/                   # 核心源码（原样迁移）
├── rust-vexus-lite/       # Rust N-API 向量引擎（保留原名：不含 VCP 字样）
├── tests/                 # 287+ 测试全量迁移
├── examples/
│   ├── demo/              # 原 CLI 演示（main.js + fake-embedding.js + README）
│   └── real-embed/        # 真实嵌入演示（demo-recall.js + .env.example 模板）
├── docs/
│   ├── ARCHITECTURE.md    # 架构总览
│   ├── GUIDE.md           # 快速上手
│   ├── FUNCTIONS.md       # 完整功能说明
│   ├── ALGORITHMS.md       # 算法族数学说明
│   ├── EMBEDDING.md       # 嵌入 Provider 体系
│   ├── PERSISTENCE.md     # 持久化与重启恢复
│   ├── API.md             # 导出参考
│   └── TROUBLESHOOTING.md # 常见问题
└── .github/workflows/ci.yml
```

`src/`、`tests/`、`rust-vexus-lite/` 内容从 `C:\dev\vcp-memory-demo\vcp-memory\`
原样复制（保持代码字节一致）；空占位目录 `knowledge/`、`VectorStoreTDB/` 不迁移。

## 功能域（来自现有 287 测试，写入文档的完整功能清单）

- **核心引擎**：MemoryEngine 生命周期（config merge → pipeline 初始化 → provider 注入 →
  store 链 → ingest/search/delete/close），createMemoryEngine 工厂
- **7 阶段管线**：ingestion / embedding / chunking / candidate / retrieval /
  postprocessing / storage；算子级 stage 组合 pipeline
- 检索：混合检索（BM25 + 多路召回）、语义去重（exact/semantic 双层）、
  **向量降维**（Gram-Schmidt 正交化）、RAG 参数装配（topK/温度/上下文窗口）
- **记忆综合体**：TagMemory 浪潮算法（wave 波浪）、RiverMemory 拓扑
  （scaled-field solver、河流可见性）、EPA 语义分析（逻辑深度/主轴/共振）、
  残差金字塔（覆盖多分辨率）
- **标签体系**：自动标签提取、标签聚类（加权 PCA、SVD、幂法）、标签索引
- **TDB 冷知识库**（TriviumDB）：独立 TDBSearchPipeline、TDBStore、adapter
- **持久化**：SQLite 元数据 + Rust N-API 向量索引双写盘、懒加载磁盘恢复
- **Provider**：抽象 EmbeddingProvider 接口；OpenAI 兼容 / DashScope 原生
  （qwen3.7-text-embedding，text_type 区分） / 测试伪嵌入；usage 统计
- **实用工具**：向量编解码 blob、文本预处理、标签提取、ResultDeduplicator

## 改名面（VCP 冠名清理，共 34 处，见清点）

- `package.json` / `package-lock.json`：`name: vcp-memory` → `memoria`
  （lock 文件同步；若不便，删除 lock 由 npm install 再生）
- `tests/integration/verify-vcptoolbox.js` → `tests/integration/verify.js`，
  内部 "vcptoolbox" 断言改为对 memoria 的安装/加载冒烟校验
- `src/compat/knowledge-base-adapter.js`、`src/config/default-config.js`：
  注释/日志中的 vcp 字样 → memoria（仅示文案，不改变行为）
- 测试内若以字符串引用包名/旧名（如 `require('vcp-memory')` 的用例），改为相对路径或新名
- examples/README 的"与 VCPToolBox 的关系"章节改写为产品定位

## 工程要求

- npm scripts：`test`（node --test 全量）、`demo`（examples/demo 章节演示）、
  `demo:recall`（真实嵌入 /examples/real-embed）、`build:rust`（cargo build 复制）
- CI `.github/workflows/ci.yml`：`npm ci && npm test` + Rust 冒烟（cargo build --release）
- 首个提交包含全部源码 + 6 平台预编译 `.node` 二进制
- 版本 v0.1.0；后续变更对应 CHANGELOG

## 验收标准

1. `git ls-files` 呈现完整仓库结构（无 vcp 残余文件名）
2. 全量 `npm test`（原 287+ 测试）在新仓库 100% 通过
3. `rg -i "vcp"` 仅剩 0useful 处（或仅出现在设计文档/历史说明）
4. examples/demo 可运行（`npm start` 或 demo 脚本），real-embed 可带真实 key 运行
5. README 中文完整覆盖：简介、特性矩阵、快速上手、文档索引、License、如何贡献