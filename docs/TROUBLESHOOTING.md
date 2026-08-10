# TROUBLESHOOTING — 常见问题排查

> 本文是实测/源码级常见问题速查表（F(x)：症状 → 原因 → 解法）。每条都
> 有对应源码位置或测试锚点，先读引擎日志再对照本条。无结果的条目一律
> 回到 [PERSISTENCE.md](PERSISTENCE.md)（存储与恢复）与
> [EMBEDDING.md](EMBEDDING.md)（维度一致性）复查。

## 速查表

| #   | 症状                                                                                 | 根因                                                                                                             | 解法                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 保存向量索引报错，含 `os error 5`（PermissionDenied/fsync 失败）                     | Rust 侧 fsync 需要**读写句柄**；Windows 只读句柄或被杀毒/只读目录拦截                                            | 保持文件可写权限；已修：`sync_index_file` 显式 read+write 打开（lib.rs:168–177）；仍有故障给目录/文件放开写权限或换盘目录                                                                               |
| 2   | `Dimension mismatch: expected N, got M`（add 时抛错）                                | provider 实际维度 ≠ `config.dimension`（索引创建/加载时固化维度，lib.rs:392–398）                                | 统一 `embeddingProvider.getDimension()` 与 `config.dimension`；换维度必须删除 `storePath`/`dbPath` 重灌（旧库失效，EMBEDDING.md §5）                                                                    |
| 3   | `corepack pnpm test` 中实时集成测试输出 SKIP                                         | 仓库根 `.env` 无 `EMBED_API_KEY`；实时测试会在缺少密钥时主动跳过                                                 | 需要实时调用时，把真实 key 写入根 `.env`（`EMBED_API_KEY=sk-...`，勿提交）；无 key 时跳过是预期行为                                                                                                     |
| 4   | 搜索空结果（历史库 `files.path` 为 `diaryX\a.md`，而引用方查 `diaryX/a.md`，命中 0） | Windows `path.relative` 产出反斜杠相对路径，旧库/外部写入未 posix 化                                             | 统一正斜杠：当前入库路径已 `relPath.split(path.sep).join('/')`（file-reader.ts:69）；存量库须把 files.path 转 `a/b.md` 形式或重灌                                                                       |
| 5   | `better-sqlite3 is not available...` 或加载报错                                      | `corepack pnpm install --ignore-scripts` 后原生绑定缺失 / 预编译不匹配                                           | `corepack pnpm rebuild better-sqlite3`（或删除 node_modules 后运行 `corepack pnpm install`）                                                                                                            |
| 6   | 重启后索引内容缺失（`getOrCreateIndex` 找不到 .usearch，建了空索引）                 | 之前进程未 `close()`（定时器未到）或 `storePath` 被清；懒加载只在*文件存在*时读回（vexus-vector-store.ts:56–73） | 检查 `storePath` 下 `index_*.usearch` 是否存在；优雅停机必须 `engine.close()`/`adapter.shutdown()`（flushPendingSaves）；目录被清则只能重灌                                                             |
| 7   | `Failed to load native binding` / `Unsupported ...` 于 rust-vexus-lite               | 本平台无预编译 `.node`（当前支持矩阵见 [NATIVE-MATRIX.md](NATIVE-MATRIX.md)）                                    | 用含 Rust 工具链环境自行构建：进入 `rust-vexus-lite` 后运行 `corepack pnpm exec napi build --platform --release`；跨平台分发时携带对应 `.node` 文件                                                     |
| 8   | 记忆召回演示（`examples/real-embed`）无输出、以 `✖ 未找到 EMBED_API_KEY` 退出        | 演示脚本读本目录 `.env`，缺 key 直接 exit 1                                                                      | 按 [示例说明](../examples/real-embed/README.md)：把 `.env` 放 `examples/real-embed/` 下（`EMBED_API_KEY=sk-...`），执行 `corepack pnpm build:test && node dist-test/examples/real-embed/demo-recall.js` |
| 9   | 初始化停在 dirty / 报 `integrity`，但 SQLite 文档仍存在                              | 派生向量索引缺失、损坏、generation 不一致，或 legacy TDB vector backfill 失败                                    | 保留 SQLite 与 dirty 状态，修复嵌入/维度或目录权限后重试 `initialize()`；不要手动把 dirty 改为 clean                                                                                                    |
| 10  | 无 scope 搜索只返回 Root，或 vector 与 BM25 结果范围不一致                           | 使用旧调用方默认值，或 metadata scope discovery 不可用                                                           | 显式检查 `getExpectedVectorIndexNames()` / `getDistinctDiaryNames()`；正常行为是无 scope 覆盖全部 authority，`Root` 仅为兼容回退                                                                        |
| 11  | close 时新操作失败、已有搜索仍在运行                                                 | 引擎已进入 `closing`，正在 drain active operations                                                               | 等待同一个 `close()` Promise 完成；重复 close 安全，失败时检查 `MemoriaError("lifecycle")` 后重试                                                                                                       |

（若某条与你所在环境不符，先看对应源码行号再操作——不要凭记忆改配置。）

---

## 1. Windows `os error 5`（Rust 向量索引保存失败）

- **征状**：`[VexusVectorStore] Scheduled save failed ... Permission denied (os error 5)`；
  或直接异常带 `fsync` / `FlushFileBuffers`。
- **根因（历史问题）**：持久化时对临时索引 `sync_all` 需要**写访问权
  句柄**；只读打开会在 Windows 上被拒（`system error 5`）。旧实现踩过
  这个坑；现实现 `sync_index_file` 显式 `.read(true).write(true).open()`
  再 sync（rust-vexus-lite/src/lib.rs:168–177），并在发布阶段对
  PermissionDenied/WouldBlock/Interrupted 做 6 档有界重试（:186–213）。
- **若仍复现**（沙箱/只读卷/杀毒占用）：
  1. 确认目标目录对当前用户可写，退出所有持有该目录句柄的程序；
  2. 若在受限 CI/沙箱，参考 `tests/providers/test-vexus-vector-store.test.ts:
192–201` 的做法：把原生 save 视为环境依赖，跳过 roundtrip 断言；
  3. 兜底：改 `storePath` 到可写目录后重灌。
- **要点**：保存失败**不会**抛到调用面（JS 侧 catch 后 console.error），
  但该次索引的磁盘态仍是旧的——重启后懒加载读到旧文件；因目标文件
  仍在，不会触发"读回失败→建空索引"分支（判断信号：重启后向量数
  比预期少 → 磁盘与内存不一致）。

## 2. 维度不匹配（provider dimension vs config.dimension）

- **根因**：`engine.ts:81–88` 以 `config.dimension` 建向量存储；所有索引
  与该维度固定（create/load 时传 dimension）。
- **表现**：`add` 抛 `Dimension mismatch: expected 3072, got 1024`
  （lib.rs:392–398）；或 BLOB 侧解码告警 `Invalid vector blob length`
  （vector-codec.ts:27–31）；去重器对维度不符的候选视为无效向量
  （result-deduplicator.ts:342–347）。
- **处理**：`openai-embedding-provider` 的类默认 1024 与引擎默认
  3072 可能冲突——**必须显式传 `config.dimension` 且等于
  `provider.getDimension()`**（EMBEDDING.md §1/§4）。换维度 = 换库：
  删除 `dbPath` 与 `storePath` 后重新 `flushBatch`，不支持原地迁移。

## 3. `corepack pnpm test` 中实时集成测试 SKIP

- **牵涉文件**：`tests/integration/real-dashscope.test.ts`。其中的实时用例会
  调用真实嵌入服务，因此数量和覆盖范围应以当前测试文件为准。
- **机制**：`loadApiKey()` 从仓库根 `.env` 读 `EMBED_API_KEY`（:40–52）；
  无值则打 `[real-dashscope] No EMBED_API_KEY in .env — all tests SKIPPED`
  并以 `skipOpts` 跳过（:90）。
- **正确处置**：本地无 key 时这是**预期行为**（不是失败）；要跑实时链，
  给根 `.env` 写真实 key（勿提交）。注意维度固定 1024、模型
  `qwen3.7-text-embedding`（:65–66）。

## 4. 搜索空结果 / `files.path` 反斜杠

- **表现**：`engine.search()` 返回 0 条或缺档；直查
  `SELECT path FROM files` 发现 `diaryX\a.md` 样式。
- **根因**：Windows 下 `path.relative` 输出反斜杠；若按反斜杠入库、按
  正斜杠查询（或反之），`getFileByPath` / 去重 identity
  （`path-chunk:...` 已 normalize 反斜杠，result-deduplicator.ts:242–244）
  全对不上 → 命中 0。
- **修复**：入库统一 posix——`file-reader.ts:69` 已
  `relPath.split(path.sep).join('/')`（测试锚点 `tests/stages/
test-ingestion-stages.test.ts:132–144` 验证 Windows 风格入参输出
  `diary/ghost.md`）。**存量库**：要么 SQL 批量把 `path` 里的 `\` 转为
  `/` 并重算关联（或直接重灌）；保持新旧路径约定一致。
- **其他空结果成因**：见 #6（索引未落盘）与 EMBEDDING §6（嵌入失败位
  null 不抛错，查询侧置 failed）。

## 5. better-sqlite3 原生绑定缺失

- **表现**：`SqliteMetadataStore` 构造抛
  `better-sqlite3 is not available...`（sqlite-metadata-store.ts:75–78）或
  `NODE_MODULE_VERSION` 不匹配。
- **根因**：`corepack pnpm install --ignore-scripts`（或某些包管理器不跑 postinstall）
  只装了 JS 壳；当前 Node ≥24（package.json engines）。
- **解法**：`corepack pnpm rebuild better-sqlite3`（或删除 node_modules 后运行
  `corepack pnpm install`）。注意它与 `rust-vexus-lite`
  是两套独立原生依赖——后者缺平台二进制见第 7 条，不被本命令覆盖。

## 6. 索引懒加载异常 / 找不到 `.usearch`

- **行为**：`getOrCreateIndex` 只在 **文件存在** 时 `VexusIndex.load`
  读回（vexus-vector-store.ts:51–73）；文件损坏/加载失败则打
  `Failed to load persisted index ... creating fresh one instead` 并
  **静默新建空索引**——之后搜索自然 0 结果。
- **查因**：1) 未 `close()` 就退出，`scheduleIndexSave` 定时器没到，
  最后写入未落盘（log 里没有保存失败也能发生）；2) `storePath` 被清空；3) 换了维度（旧文件维度不符）→ 检查 `storePath` 下 `index_*.usearch`
  是否存在及其保存时间。
- **处理**：存在但内容旧 → 重新 `close()`/`shutdown()` 触发 flush；
  不存在 → 无可恢复，只能重灌（或手动 `saveIndex` 先保存一次）。

## 7. Rust 预编译二进制缺平台

- **症状**：native loader 抛 `Failed to load native
binding` 或 `Unsupported OS/architecture`（`rust-vexus-lite/index.js:299–310` 的 switch
  兜底）。
- **现状**：仓库内置 win32-x64-msvc、linux-x64-gnu/musl、linux-arm64-
  gnu/musl、darwin-arm64 的 `.node`（根目录文件名即平台标记）。若跨平台
  分发少了当前平台/arch，**自行构建**：进入 `rust-vexus-lite` 后运行
  `corepack pnpm exec napi build --platform --release`（需 Node ≥24 + Rust stable + 对应
  target），产物放回包内
  `vexus-lite.<platform>-<arch>.node` 即可离线 require。

## 8. 记忆召回演示无输出 / 无 key 前缀提示

- **行为**：编译后的 `dist-test/examples/real-embed/demo-recall.js` 未读到本目录 `.env` 的
  `EMBED_API_KEY` 时输出 `✖ 未找到 EMBED_API_KEY...` 并 exit 1
  （[examples/real-embed/README.md](../examples/real-embed/README.md) 的“无 key 提示”一节）。
- **解法**：在该目录放 `.env`（`EMBED_API_KEY=sk-...`）；注意它与第 3 条的
  “仓库根 `.env`”是**两个文件**——测试
  读根 `.env`，演示读自己的 `.env`。
- 若 key 存在仍无输出，对照第 1/2 条（目录权限、维度 1024 与模型
  `qwen3.7-text-embedding` 是否一致）。

## 附：通用排查顺序

1. 日志关键字：`os error` / `Dimension mismatch` / `Failed to load
persisted index` / `Failed to save temporary index` / `not available`；
2. 文件检查：`storePath` 下 `index_*.usearch` 与 `memory.sqlite` 存在性与
   时间戳（PERSISTENCE.md §7 布局）；
3. 停机验证：先 `engine.close()`（= `adapter.shutdown()`）再查盘；未 flush
   是多数"重启少数据"的直接原因（PERSISTENCE.md §4/§8）。
