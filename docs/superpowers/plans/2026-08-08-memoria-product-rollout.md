# memoria 产品化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 vcp-memory 迁移为独立产品仓库 `C:\dev\memoria`（完整仓库结构、去掉 VCP 冠名、中文文档、MIT、CI、首提交）。

**Architecture:** 单包产品仓库（方案 A 已批准）。源码/测试/Rust 引擎原样字节复制，包名 `vcp-memory` → `memoria`，栅栏式清理 34 处 VCP 字样（注释、临时目录前缀、标签断言、verify 脚本），examples/ 收纳原 demo 与真实嵌入演示，docs/ 8 篇中文文档，README 为产品入口。

**Tech Stack:** Node.js >= 18 / better-sqlite3 / Rust N-API（预编译二进制随附）/ @dqbd/tiktoken / chokidar

**源仓库（只读）：** `C:\dev\vcp-memory-demo\vcp-memory`（以下称 SOURCE）
**目标仓库：** `C:\dev\memoria`（已 git init + spec 提交，以下称 TARGET）

---

### Task 1: 仓库骨架 + 源码镜像

**Files:**
- Create: `C:\dev\memoria\LICENSE`
- Create: `C:\dev\memoria\CHANGELOG.md`
- Create: `C:\dev\memoria\.gitignore`
- Modify: `C:\dev\memoria\package.json`（复制后改 name）
- Modify: `C:\dev\memoria\package-lock.json`（复制后替换 2 处 name）
- Copy: `index.js`、`src/`、`tests/`、`rust-vexus-lite/`（整树）

- [ ] **Step 1: 复制代码树到 TARGET，排除仓库级/运行产物**

```pwsh
$src = 'C:\dev\vcp-memory-demo\vcp-memory'; $dst = 'C:\dev\memoria'
Copy-Item "$src\index.js" $dst\
Copy-Item "$src\src" "$dst\src" -Recurse -Force
Copy-Item "$src\tests" "$dst\tests" -Recurse -Force
Copy-Item "$src\rust-vexus-lite" "$dst\rust-vexus-lite" -Recurse -Force
Copy-Item "$src\package.json" $dst\
Copy-Item "$src\package-lock.json" $dst\
# rust target/ 与 node_modules 已存在于源，整树复制会带入体积；目标仓库保留
# target/ 与 node_modules/（构建产物），但 .gitignore 排除（Task 1 Step 3）
```

注意：`rust-vexus-lite\node_modules` 与 `rust-vexus-lite\target` 一并复制（离线可运行），由 Task 1 Step 3 的 .gitignore 排除。空目录 `knowledge/`、`VectorStoreTDB/` 不复制。

- [ ] **Step 2: 改名 package.json / package-lock.json**

`TARGET\package.json`：`"name": "vcp-memory"` → `"name": "memoria"`。
`TARGET\package-lock.json`：全部 `vcp-memory` 字符串（root 包名 + `packages["vcp-memory"]` 键）→ `memoria`（共 2 处）。

```bash
$f = 'C:\dev\memoria\package.json'; (Get-Content $f -Raw).Replace('"vcp-memory"','"memoria"') | Set-Content $f -NoNewline
$f = 'C:\dev\memoria\package-lock.json'; (Get-Content $f -Raw).Replace('vcp-memory','memoria') | Set-Content $f -NoNewline
```

- [ ] **Step 3: 写 LICENSE（MIT，版权人 Arsvine Zhu）**

`TARGET\LICENSE` 完整 MIT 文本：
```
MIT License

Copyright (c) 2026 Arsvine Zhu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 4: 写 CHANGELOG.md**

```markdown
# Changelog

## 0.1.0 (2026-08-08)

首个独立发布，能力继承 vcp-memory 全部积累：

- MemoryEngine 全生命周期：config merge / pipeline 初始化 / provider 注入 / 读写删
- 7 阶段检索管线（ingestion/embedding/chunking/candidate/retrieval/postprocessing/storage）
- 混合检索（向量 + BM25）、语义去重（exact/semantic）、Gram-Schmidt 向量正交化
- 记忆综合体：TagMemory 浪潮算法、RiverMemory 拓扑（scaled-field solver / 河流可见性）、
  EPA 语义分析（逻辑深度/主轴/共振）、残差金字塔
- 标签体系：自动提取、加权 PCA / SVD 聚类、标签索引
- TDB 冷知识库（TriviumDB）：独立搜索管线、TDBStore、adapter
- 持久化：SQLite 元数据 + Rust N-API 向量索引，双写盘 + 懒加载恢复
- 嵌入 Provider：OpenAI 兼容、DashScope 原生（qwen3.7-text-embedding，document/query 双模式）、测试伪嵌入
- Rust N-API 向量引擎（rust-vexus-lite）：6 平台预编译二进制内置
```

- [ ] **Step 5: 写 .gitignore**

```
node_modules/
rust-vexus-lite/node_modules/
rust-vexus-lite/target/
examples/demo/demo-data/
examples/real-embed/.env
*.sqlite
*.usearch
```

- [ ] **Step 6: Commit**

```bash
cd C:\dev\memoria
git add -A
git commit -m "chore: mirror vcp-memory source tree as memoria v0.1.0"
```

---

### Task 2: VCP 冠名清理（静态代码）

**Files:**
- Rename: `TARGET\tests\integration\verify-vcptoolbox.js` → `TARGET\tests\integration\verify.js`
- Modify: `TARGET\src\compat\knowledge-base-adapter.js:26`
- Modify: `TARGET\src\config\default-config.js:6`
- Modify: `TARGET\tests\utils\test-text-preprocessor.test.js:27-29`
- Modify: 7 个测试文件的 mkdtemp 前缀

- [ ] **Step 1: 重命名并重写 verify.js**

```bash
Rename-Item C:\dev\memoria\tests\integration\verify-vcptoolbox.js verify.js
```

打开 `TARGET\tests\integration\verify.js`：所有 `vcptoolbox`/`VCPToolBox` 字样改为
`memoria` 风格、注释首行改为 `memoria smoke verification`；其内部仅做
内存库自校验（创建临时 engine → 灌入 → 检索 → close），不依赖外部服务。改写后内容与
原脚本行为一致，只是品牌字样变化（该脚本是独立冒烟脚本，无被引方）。

- [ ] **Step 2: 修正注释文案（行为不变）**

- `knowledge-base-adapter.js:26` 注释行
  `*   modules/vcpLoop/toolExecutor.js:138   kbm.db.prepare(...), kbm.search(diary, vec, n),` → 移除 vcpLoop 字样，改写为 `*   host app integration: kbm.db.prepare(...), kbm.search(diary, vec, n),`
- `default-config.js:6` `* Default configuration for the vcp-memory engine.` → `* Default configuration for the memoria engine.`

- [ ] **Step 3: 测试文件品牌化（不影响断言语义）**

`test-text-preprocessor.test.js:27-29`：

```js
const content = 'Some diary content.\n\nTag: MEMORIA, 记忆系统, 文档';
...
assert.ok(tags.includes('MEMORIA'));
```

其余 mkdtemp 前缀（保持唯一性即可，纯字符串前缀）：
- `test-tdb.test.js:41` `'vcp-memory-vec-'` → `'memoria-vec-'`；`:54` `'vcp-memory-tdb-'` → `'memoria-tdb-'`
- `test-ingestion-stages.test.js:47,72,104,149` `'vcpmem-*'` → `'memoria-*'`
- `test-knowledge-base-adapter.test.js:18` `'vcp-memory-adapter-'` → `'memoria-adapter-'`
- `test-knowledge-base-adapter-rag.test.js:18` `'vcp-memory-rag-'` → `'memoria-rag-'`
- `test-sqlite-metadata-store.test.js:594` `'vcp-sqlite-test-'` → `'mem-sqlite-test-'`
- `test-pipelines.test.js:66` `'vcp-memory-pipeline-'` → `'memoria-pipeline-'`

（其余 vcp 命中已随 Task 1/Step 2 处理；用下方验收命令复查）

- [ ] **Step 4: 验收 + Commit**

```bash
rg -i "vcp" C:\dev\memoria --glob '!docs/**' --glob '!rust-vexus-lite/target/**' --glob '!*build*' --glob '!node_modules/**' -l
# 预期：仅 CHANGELOG.md（历史说明有意保留）可能命中或为空
git add -A
git commit -m "refactor: strip VCP branding, verify.js rename"
```

---

### Task 3: 全量测试验证（改名不破坏行为）

- [ ] **Step 1: 清理旧 lock 一致性并安装依赖**

```bash
Set-Location C:\dev\memoria
node -e "const l=require('./package-lock.json'); if(l.name!=='memoria'){console.error('lock name wrong');process.exit(1)}"
npm ci --ignore-scripts   # 或 npm install（离线 node_modules 已在）
```

- [ ] **Step 2: 按目录分区跑全量测试（11 组）**

```bash
@("algorithms","core","engine","fixtures","integration","pipelines","providers","stages","tdb","utils") | ForEach-Object {
  node --test "tests/$_/*.test.js" 2>&1 | Select-String -Pattern "ℹ (tests|pass|fail)"
}
node --test "tests/algorithms/topology/*.test.js" 2>&1 | Select-String -Pattern "ℹ (tests|pass|fail)"
```

期待：合计 ≥287 tests / pass≥287 / fail 0 / skipped 0。

- [ ] **Step 3: 运行 verify.js 冒烟**

```bash
node tests/integration/verify.js
# 预期输出包含 memoria 与成功信息、Exit 0
```

- [ ] **Step 4: Commit**

```bash
git add -A; git commit -m "test: full suite green under memoria name"
```

---

### Task 4: examples/demo 迁移（原 CLI 章节演示）

**Files:**
- Create: `TARGET\examples\demo\main.js`、`fake-embedding.js`、`README.md`、`package.json`
- Modify: `main.js` 中 `require('./vcp-memory')` → `require('../..')`

- [ ] **Step 1: 复制并改写首部注释与 require**

- `C:\dev\vcp-memory-demo\main.js` → `C:\memoria\examples\demo\main.js`
- `C:\dev\vcp-memory-demo\fake-embedding.js` → `C:\memoria\examples\demo\fake-embedding.js`
- `main.js` 首行注释 `vcp-memory 记忆库最小演示` → `memoria 命令行演示`
- `main.js` 顶部 `require('./vcp-memory')` → `require('../..')`（两处：createMemoryEngine 与 KnowledgeBaseAdapter/FakeEmbedding 引用，按源码实际行改）

- [ ] **Step 2: examples/demo/README.md**

重写为 中文段落：(1) 这是 memoria 的 CLI 章节演示（6 章节：初始化/摄入/基础检索/高级检索/删除/收尾）；(2) `node main.js` 一键运行，零网络零配置；(3) `fake-embedding.js` 是离线确定性伪嵌入（128 维），与 EmbeddingProvider 接口兼容；(4) 目录结构说明。

- [ ] **Step 3: 运行验证**

```bash
Set-Location C:\dev\memoria; node examples/ --help  # 先确认 demo 可启动
node examples/demo/main.js  # 预期 6 章节输出、Exit 0；若缺 demo-data 目录则脚本自建
```

- [ ] **Step 4: Commit**

```bash
git add -A; git commit -m "feat: migrate CLI demo into examples/demo"
```

---

### Task 5: examples/real-embed 迁移（真实嵌入演示）

**Files:**
- Create: `TARGET\examples\real-embed\demo-recall.js`、`README.md`、`.env.example`、`package.json`

- [ ] **Step 1: 迁移演示脚本**

- `C:\dev\vcp-memory-demo\demo-recall.js` → `C:\memoria\examples\real-embed\demo-recall.js`
- 改 4 处路径/字符串：
  - `require('./vcp-memory')` → `require('../..')`
  - `require('./vcp-memory/src/compat/knowledge-base-adapter')` → `require('../../src/compat/knowledge-base-adapter')`
  - `require('./vcp-memory/src/providers/dashscope-embedding-provider')` → `require('../../src/providers/dashscope-embedding-provider')`
  - `join(__dirname,'vcp-memory/tests/fixtures/real-docs')` → `join(__dirname,'../../tests/fixtures/real-docs')`
- 文档注释中 "VCPToolBox 记忆召回演示" → "memoria 记忆召回演示"

- [ ] **Step 2: .env.example**

```
# DashScope 密钥（https://dashscope.console.aliyun.com 获取）
EMBED_API_KEY=sk-xxxxxxxxxxxxxxxx
```

- [ ] **Step 3: real-embed/README.md（中文）**

内容：目的（真实 API 端到端回忆演示：10 篇中文文档 → 6 组语义查询 → 打印命中/来源/标签）、前提（.env 配 EMBED_API_KEY）、运行 `node demo-recall.js`、输出样式示例 1-2 行、无 key 时提示信息。

- [ ] **Step 4: 运行验证（有 key 时）+ Commit**

```bash
# 临时为 examples/real-embed 生成 .env（复制 demo 的），运行后删除
cp C:\dev\vcp-memory-demo\.env C:\memoria\examples\real-embed\.env
node examples/real-embed/demo-recall.js   # 预期 6 组查询全部命中对应文档（quantum/fitness/tcm/...）
rm examples/real-embed/.env   # .gitignore 排除，勿提交
git add -A; git commit -m "feat: migrate real-embed recall demo into examples/real-embed"
```

---

### Task 6a: README.md（产品入口，中文）

**Files:** Create: `C:\dev\memoria\README.md`

- [ ] **Step 1: 写入完整 README**（大纲+文案直接在文件中展开，要点如下）

1. 标题 + 一句话定位：**memoria — 面向 AI 应用的持久化语义记忆系统**（TagMemo 浪潮 / RiverMemo 拓扑 / EPA / TDB）
2. 特性矩阵（10 项）：向量 + BM25 混合检索、TagMemory 浪潮激活、RiverMemory 拓扑、EPA 语义深度、残差金字塔覆盖、自动标签与聚类、TDB 冷知识库、SQLite+Rust 双持久化、Provider 抽象（OpenAI/DashScope/伪）、Rust N-API 原生速度
3. 架构概览（5 行 + 目录树一张）
4. 快速开始（npm install + 15 行真实代码：createMemoryEngine + FakeEmbedding → flushBatch → search → close）
5. 示例：`examples/demo`（离线）与 `examples/real-embed`（真实 API）
6. 文档导航表（docs/ 8 篇）
7. License：MIT；如何贡献一句话

内容与 `docs/GUIDE.md` 互补（README 不重复细节）。

- [ ] **Step 2: Commit**

```bash
git add README.md; git commit -m "docs: product landing README"
```

---

### Task 6b: docs/ 文档（8 篇，中文）

**Files:** `ARCHITECTURE.md`、`GUIDE.md`、`FUNCTIONS.md`、`ALGORITHMS.md`、`EMBEDDING.md`、`PERSISTENCE.md`、`API.md`、`TROUBLESHOOTING.md`

- [ ] **Step 1: ARCHITECTURE.md** — 总览：MemoryEngine 生命周期（创建→config merge→pipeline 初始化→provider 注入→store 链→ingest/search/delete/close）；pipeline 23 步编排（对照 src/pipelines/…）；组件分层表（core/config/compat/providers/stages/algorithms/utils/tdb）；目录树对照注释。

- [ ] **Step 2: GUIDE.md** — 15 行代码 quickstart（与 README 同源但完整版）；config 参数速查表（dimension/rootPath/storePath/chunkMaxTokens/chunkOverlapTokens/indexSaveDelay/tagIndexSaveDelay 等 tolerance：默认 3072）；Provider 注入两条路（构造 new XxxProvider 或 loadRagParams）；删除/清空语义；常用指标（文件/块/标签/向量数）。

- [ ] **Step 3: FUNCTIONS.md（完整功能说明）** — 按功能域组织并双向对照 tests：引擎（engine.test 62 断言）、7 阶段（ingestion/chunking/embedding/retrieval/postprocessing/storage）、混合检索（candidate 融合/去重阈值 exact 1.0 semantic 0.92）、EPA 三量（逻辑深度/主轴/共振）、TagMemory（wave 传播 FIR 系数）、RiverMemory（scaled-field 求解/observability）、残差金字塔、标签（extractTags/clusterTags）、TDB（入库/搜索/持久化）、delete 级联、usage 统计。每节附"验证视角：tests/<路径>" 指引。

- [ ] **Step 4: ALGORITHMS.md** — 数学维面：wave-propagation（传播矩阵/FIR 权重）、scaled-field-solver（对偶标度求解/支持集）、river-observability、Gram-Schmidt 正交化与投影（向量空间降维理由）、SVD/加权 PCA/幂法/基维选择（clusterTags 的维数约简含义）、余弦相似度归一化基线。

- [ ] **Step 5: EMBEDDING.md** — Provider 接口契约（embedBatch 输入输出/dimension 一致性）；三种实现对比表：OpenAI 兼容（/v1/embeddings、3072 默认）、DashScope 原生（qwen3.7-text-embedding、1024 维、input.texts + parameters.dimension/output_type/text_type、分批 ≤20）、FakeEmbeddingProvider（128 维确定性、离线）；切换注意（维度同步、key 来源）；局限（无 OAuth2、无代理支持）。

- [ ] **Step 6: PERSISTENCE.md** — 存储架构三表：files/chunks/tags（SQLite）+ 向量索引（Rust .usearch 文件）；写入路径（flushBatch 双写）、懒加载重开（getOrCreateIndex 磁盘读回）、保存时序（indexSaveDelay）、失败恢复（os error 5 说明）、清理注意事项。

- [ ] **Step 7: API.md** — 导出符号表分九组：Core（Pipeline/Stage/Context）、Engine Factory（createMemoryEngine/MergeConfig/loadRagParams*）、Adapter、TDB 系、算法族（EPA/ResidualPyramid/ResultDeduplicator）、Gram-Schmidt、SVD、拓扑、工具（decodeVectorBlob/encode/prepareTextForEmbedding/extractTags）；每符号一行参数/返回/默认值。

- [ ] **Step 8: TROUBLESHOOTING.md** — F(x) 表：Windows `os error 5`（Rust fsync/句柄 → read+write 打开/权限）、维度不匹配（provider 维 vs config.dimension）、无 key 时测试 skip、搜索空（posix/反斜杠 relpath）、`better-sqlite3` 重编译（npm rebuild）、懒加载索引缺失（晚 flush）。

- [ ] **Step 9: Commit**

```bash
git add docs; git commit -m "docs: full docs suite (8 guides, zh)"
```

---

### Task 7: CI + 最终验收 + 首提交

**Files:** Create: `C:\dev\memoria\.github\workflows\ci.yml`

- [ ] **Step 1: CI workflow**

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm test
  rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - working-directory: rust-vexus-lite
        run: cargo build --release
```

- [ ] **Step 2: 最终验收清单**

```bash
# 1) VCP 冠名清零（除 CHANGELOG 有意保留与外历史说明）
rg -i "vcp" C:\dev\memoria\src C:\dev\memoria\tests --glob '!*.md' | Measure-Object   # 预期 0
# 2) 全量测试绿
node --test "tests/**/*.test.js" 2>&1 | Select-String -Pattern "ℹ (tests|pass|fail)"  # pass>=287 fail=0
# 3) demo 可运行（离线）
node examples/demo/main.js | Select-Object -First 4      # 章节标题输出即可
# 4) git 状态干净
git status --short   # 空
```

- [ ] **Step 3: 总提交**

```bash
git add -A
git commit -m "build: CI workflow; final product snapshot v0.1.0"
git log --oneline | Select-Object -First 8
```

---

## Self-Review 备注

- **Spec 覆盖**：目录结构（Task 1/4/5/6b）、改名 34 处（Task 2 + Task 4/5 演示脚本）、README（Task 6）、LICENSE/版本（Task 1）、CI（Task 7）、完整功能说明（Task 6b 的 FUNCTIONS/ALGORITHMS/EMBEDDING/PERSISTENCE/API/TROUBLE）、验收（Task 7 Step 2）——全部覆盖。examples/real-embed 的 `.env.example` 在 Task 5 Step 2。
- **无占位符**：每步均有明确文件/命令/预期输出；文档章节给要点而非 TBD。
- **语义一致**：verify.js 同时改名与 clean（无引用方）；`tests/integration/verify-vcptoolbox.js` 之外无别处引用。README 与 GUIDE 保持同源（Task 6 注明避免重复）。