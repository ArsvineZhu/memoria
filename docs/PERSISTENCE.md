# PERSISTENCE — 持久化与重启恢复

> 本文说明 memoria 的存储架构与重启恢复机制：元数据（SQLite，better-sqlite3）
> 与向量索引（Rust N-API `vexus-lite` 的 `.usearch` 文件）双写落盘、逻辑文档
> upsert、SQLite 权威重建、flush 时序（`flushBatch` / `indexSaveDelay` /
> `flushPendingSaves`）、
> 懒加载磁盘读回（`getOrCreateIndex`）、Rust 侧的原子发布与 Windows 权限
> 修复历史、真实页面布局示例与清理注意事项。所有行为以
> `src/engine.ts`、`src/providers/*`、`src/stages/ingestion/*` 与
> `rust-vexus-lite/src/lib.rs` 源码为准。

## 1. 存储架构总览

```
MemoryEngine（src/engine.ts；发布产物为 `dist/engine.js`）
├─ metadataStore: SqliteMetadataStore   （better-sqlite3，五表）
│    dbPath 默认 ':memory:'（default-config.ts:26）；传参后落盘 memory.sqlite
└─ vectorStore: VexusVectorStore        （Rust usearch 索引）
     storePath 默认 <cwd>/VectorStore（default-config.ts:25）
     ├─ 每个命名索引一个文件：index_<md5(name)>.usearch
     └─ 全局标签索引命名 'global_tags'（vector-indexer.ts:6）
```

两套存储通过**同一批 chunk/tag 的主键 id 对齐**：SQLite 的
`chunks.id` / `tags.id` 即向量索引里的 key（`VectorIndexerStage` 写入顺序
保证一致性，见 §4）。Rust 索引"无状态"（lib.rs 注释：只存向量），
id ↔ 内容的映射关系完全由 SQLite 侧负责（`VexusIndex.load` 的 map_path
参数已被忽略，lib.rs:294–303）。

## 2. SQLite 元数据（src/providers/sqlite-metadata-store.ts）

建表 SQL 见 `SCHEMA_SQL`（:12–52），共五张表：

| 表          | 关键列                                                                                                                            | 说明                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `files`     | `path UNIQUE`、`diary_name`、`checksum`、`mtime`、`size`、`updated_at`、`document_id`、`revision`、`source_json`、`metadata_json` | 文件或逻辑文档元数据；逻辑文档使用确定性内部路径，source/metadata 为 JSON                  |
| `chunks`    | `file_id`、`chunk_index`、`content`、`vector BLOB`                                                                                | 分块内容 + 向量 BLOB（`encodeVectorBlob` 原始 f32 字节，长度 = dim×4，vector-codec.ts:27） |
| `tags`      | `name UNIQUE`、`vector BLOB`                                                                                                      | 标签向量                                                                                   |
| `file_tags` | `(file_id, tag_id)` 复合主键、`position`                                                                                          | 文件-标签关联，`position` 保持输入顺序（:262–279）                                         |
| `kv_store`  | `key` 主键、`value`、`vector`                                                                                                     | 检查点等键值                                                                               |

连接 PRAGMA（:92–97）：`journal_mode = WAL`、`synchronous = NORMAL`、
`foreign_keys = ON`、`busy_timeout = <busyTimeout 默认 10000ms>`。
WAL 模式意味着 `.sqlite-wal` / `.sqlite-shm` 伴生文件与主库同目录
（见 §8 清理）。

检查点：`kv_store` 由 `MetadataWriterStage._maybeWriteCheckpoint`
（metadata-writer.ts:133–156）在 `checkpoint.enabled` / `checkpointInterval`
配置下写入 `memory_checkpoint`、`last_file_indexed`、`chunk_count`、
`tag_count`、`diary_count`（键名见 :8–14）。`checkpoint()`
（sqlite-metadata-store.ts:335）提供 `wal_checkpoint(TRUNCATE)` 能力，
属 MetadataStore 接口（interfaces/metadata-store.ts:162），由宿主按需调用
（引擎默认不自动调用）。

`buildCooccurrenceMatrix`（:301–318）用 `file_tags` 自连接产出
共现邻接（TagMemo/V10 的图算子输入）。

## 3. Rust 向量索引（src/providers/vexus-vector-store.ts）

- **命名**：`_getIndexPath`（:99–105）以 `md5(indexName)` 生成
  `index_<32hex>.usearch`，落在 `storePath` 下。索引名即引擎里的
  diary 名或 `global_tags`（`VectorIndexerStage`，vector-indexer.ts:36–38）。
- **容量**：`tagIndexCapacity` 默认 50000（:31），加载时若现有容量不足会
  扩容（lib.rs:322–329）；写入时自动 1.5× 扩容（lib.rs:401–407）。
- **维度**：每个索引在创建/加载时固定 `dimension`（构造注入）；
  Rust 侧 `add` 对维度不匹配直接抛 `Dimension mismatch: expected N, got M`
  （lib.rs:392–398），因此 `config.dimension` 必须等于
  `embeddingProvider.getDimension()`（见 TROUBLESHOOTING）。
- **加载开关**：`indexLoadEnabled`（默认 true，:35）为 false 时跳过磁盘读回。

## 4. 摄入时序：SQLite 先写，向量后写

`ingest(document)`、`ingestBatch(documents)` 是内容中心入口；`flushBatch(files)`
保留文件快照兼容面。两者都逐条跑 IngestPipeline，两个写入 stage 依次落库：

```
flushBatch → … → MetadataWriterStage（SQLite 写）→ VectorIndexerStage（Rust 写）
```

1. **SQLite 写**（metadata-writer.ts:36–131）：
   `upsertFile` → `insertChunks`（先删旧 chunk 再插，:155–179）→
   `upsertTags` → `setFileTags`。旧 chunk id 在删除前采集为
   `removedChunkIds`，供下一步清理向量索引（:69–74）。
2. **Rust 写**（vector-indexer.ts:28–74）：
   先按 `removedChunkIds` 删除陈旧向量（防止重嵌文件留下孤儿）；
   chunk 向量按 `diaryName`（无则 `Root`）写索引，tag 向量写
   `global_tags`；重复 key 走 remove-then-add 的 upsert 兜底（:76–89）。
3. **调度保存**：对每个被触碰的索引调用 `scheduleIndexSave`
   （vector-indexer.ts:68–71）。`scheduleIndexSave`（vexus-vector-store.ts:112–131）
   每个索引名只保留一个定时器（coalesce，后续调用合并），到期执行
   `index.save(filePath)`：

   | 索引               | 延迟默认值（类内 :32–33）     | 引擎配置默认（default-config.ts:41–42） |
   | ------------------ | ----------------------------- | --------------------------------------- |
   | `global_tags`      | `tagIndexSaveDelay` = 10000ms | 300000ms                                |
   | 其他（diary 索引） | `indexSaveDelay` = 5000ms     | 120000ms                                |

   `persistTagIndex` 为历史兼容构造项（构造保留，:34），当前实现不按它
   门控调度——`global_tags` 同样进入定时保存。

**关闭时序**（engine.ts:356–370）：`close()` 先 `flushPendingSaves()`
再 `metadataStore.close()`。`flushPendingSaves`（vexus-vector-store.ts:238–257）
的语义是**保存当前内存中所有已加载索引 + 清空全部定时器**（不只是
"有定时器"的索引；测试 `tests/providers/test-vexus-vector-store.test.ts:264`
断言 "persists ALL indices, not only scheduled ones"），单个索引保存失败
仅 console.error、不阻塞关闭（engine.ts:362–365 同样 catch）。
生产停机挂钩：`knowledge-base-adapter.shutdown()` = `engine.close()`
（compat/knowledge-base-adapter.ts:113–115）。

## 5. 权威重建与恢复一致性

`MemoryEngine.initialize()` 在引擎变为 ready 前调用 `reconcile()`。
`src/reconciliation.ts` 只读取 SQLite 的 chunks/tags 与 BLOB 向量，校验维度后通过
`VexusVectorStore.replaceIndex()` 重建命名索引；因此磁盘索引丢失、旧索引残留或
vector write 在 metadata commit 后失败，都能在下次启动时恢复。重建报告包含
`metadataChunks`、`usableVectors`、`skippedVectors` 与 `rebuiltIndexes`。损坏或维度
不符的 BLOB 会被跳过并记录，而不会伪造可搜索向量。

逻辑文档以 `document_id` 唯一识别；`revision` 相同且内容摘要不变时摄入幂等，
revision 或 content 改变时替换同一 files 行及其 chunks。`remove(documentId)` 不依赖
原始文件路径。

## 6. 懒加载恢复（getOrCreateIndex）

`getOrCreateIndex(indexName)`（vexus-vector-store.ts:51–77）：
内存 Map 命中直接返回；未命中且 `indexLoadEnabled && _indexFileExists`
时调用 `VexusIndex.load(path, null, dimension, cap)` 从磁盘读回
（:57–64）；读回失败（文件损坏/版本不符）打印
`Failed to load persisted index ... creating fresh one instead`
并**静默新建空索引**（:65–73）；文件不存在则新建。因此它是启动重建前的
优化路径，不是权威数据源：

- 正常重启：进程内存清空，但 `storePath` 下的 `index_*.usearch` 仍在 →
  首次 `add`/`search` 自动读回，无需显式 `loadIndex`。
- 测试锚点：`tests/providers/test-vexus-vector-store.test.ts:304`
  （`getOrCreateIndex lazily loads a persisted index from disk`）与
  :331–334（同 storePath 新实例自动加载）。启动时的权威路径由上一节的
  `reconcile()` 负责；即使 `.usearch` 全部删除，只要 SQLite 和 chunk vector BLOB
  仍在，索引也会被重建。

## 7. Rust 侧原子落盘与 Windows 修复历史（rust-vexus-lite/src/lib.rs）

`VexusIndex.save(path)`（lib.rs:345–381）三步发布：

1. **写临时文件**：先写 `unique_index_sidecar_path(target, "tmp")`
   （:148–166）——目标同目录、唯一命名
   `.{文件名}.tmp.{pid}.{纳秒时间戳}.{序列}`，保证 rename 不跨文件系统。
2. **fsync 落盘**：`sync_index_file`（:168–177）**显式以 read+write 句柄
   打开再 `sync_all`**。修复历史：Windows 上只读句柄对
   FlushFileBuffers 返回 `PermissionDenied (os error 5)`；改为读写句柄后
   跨平台 fsync 语义一致（源码注释即为此事）。
3. **原子发布**：Windows 走 `publish_index_file`（:215–263）——
   旧目标 rename 为唯一 `.bak` 备份 → 临时文件 rename 到目标 → 删备份；
   失败回滚备份；对杀毒/索引器短暂持有句柄造成的
   `PermissionDenied/WouldBlock/Interrupted` 做有界退避重试
   （`retry_windows_file_operation`，:186–213，6 档 20→500ms）。
   Unix 直接 rename + 同步父目录（:255–260）。

任一步失败都会清理临时文件并把错误上抛（:357–359 / :365–367 / :373–375），
JS 侧 `flushPendingSaves` / `scheduleIndexSave` 捕获并 console.error。

## 7. 真实页面布局示例

离线验证产物（`examples/demo/demo-data/`，仓库内真实文件）：

```
demo-data/
├─ memory.sqlite              # SQLite 主库（WAL 模式，运行期伴生 -wal/-shm）
└─ indices/
   ├─ index_370757d2df51ae456bf63c165fc71817.usearch
   ├─ index_acc943c5418181f5b95e635549047332.usearch
   ├─ index_cd69b4957f06cd818d7bf3d61980e291.usearch
   └─ index_e155e1bb4a9c38e3baf90637ab7865df.usearch
```

- 文件名为 `index_<md5(diaryName)>.usearch`，即 §3 的命名规则；
- `tests/integration/verify.ts:94` 用 `path.join(storePath, 'memoria.sqlite')`
  命名主库——库名可由宿主自定，`.usearch` 文件名才是固定规则；
- 向量 + 元数据重启恢复的完整验证路径：`tests/integration/real-dashscope.test.ts:253`
  （真实嵌入下的落盘 + 重开搜索）。

## 8. 清理注意事项

- **临时索引残留**：崩溃/杀进程可能留下
  `.{文件名}.tmp.*` / `.{文件名}.bak.*` sidecar（lib.rs:148–166 的
  tmp/bak role）。Rust 正常路径失败即删 temp、成功删 bak，但
  kill -9 / 断电不会清理。建议在引擎停机的维护窗口删除
  `storePath` 下匹配 `.*\.(tmp|bak)\..*` 的侧车文件（保留 `index_*.usearch`）。
- **WAL 伴生文件**：`memory.sqlite-wal` / `-shm` 是 SQLite WAL 的正常
  组成部分，删除会丢未检查点数据；仅在主库文件完整迁移时同批带走。
- **双写一致性**：删除 `storePath` 下的 `.usearch` 而保留 SQLite，
  或反之，都会造成 id 空洞或搜索空结果——重灌时应成对删除
  `dbPath` 与 `storePath` 后重新 `flushBatch`（维度更换时同理，见
  `docs/EMBEDDING.md` §5）。
- **定时器**：不调 `close()` 而直接退出进程，`scheduleIndexSave` 的
  定时器可能未到期，最后几批向量丢失。优雅停机务必走
  `engine.close()` / `adapter.shutdown()`。

## 9. TDB 冷知识库（简要）

`src/tdb/` 复用同一套持久化约定：`TDBStore`（better-sqlite3，`files`
表以 `(library, path)` 唯一、`chunks` 存 `library/path` 与节点 id，
tdb-store.ts:12–40）＋ `VexusVectorStore`（storePath 取
`config.tdbStorePath`，tdb-engine.ts:81）。重启恢复路径与主引擎一致
（懒加载 + close 前 flush）。
