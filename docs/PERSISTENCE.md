# PERSISTENCE — 持久化与重启恢复

> 本文说明 memoria 的存储架构与重启恢复机制：元数据（SQLite，better-sqlite3）
> 与向量索引（Rust N-API `vexus-lite` 的 `.usearch` 文件）双写落盘、逻辑文档
> upsert、generation/dirty recovery、SQLite 权威重建、flush 时序
> （`flushBatch` / `indexSaveDelay` / `flushPendingSaves`）、持久化索引验证与
> 派生状态清理、Rust 侧的原子发布与 Windows 权限修复历史、真实页面布局示例
> 与清理注意事项。所有行为以
> `src/engine.ts`、`src/providers/*`、`src/stages/ingestion/*` 与
> `rust-vexus-lite/src/lib.rs` 源码为准。

## 1. 存储架构总览

```
MemoryEngine（src/engine.ts；发布产物为 `dist/engine.js`）
├─ metadataStore: SqliteMetadataStore   （better-sqlite3，五表）
│    dbPath 默认 <cwd>/data/memoria/memory.sqlite
└─ vectorStore: VexusVectorStore        （Rust usearch 索引）
     storePath 默认 <cwd>/data/memoria/indexes
     ├─ 每个命名索引一个文件：index_<md5(name)>.usearch
     └─ 全局标签索引命名 'global_tags'（vector-indexer.ts:6）
```

两套存储通过**同一批 chunk/tag 的主键 id 对齐**：SQLite 的
`chunks.id` / `tags.id` 即向量索引里的 key（`VectorIndexerStage` 写入顺序
保证一致性，见 §4）。Rust 索引"无状态"（lib.rs 注释：只存向量），
id ↔ 内容的映射关系完全由 SQLite 侧负责（`VexusIndex.load` 的 map_path
参数已被忽略，lib.rs:294–303）。

## 1.1 托管数据目录与 MDX 源文件

默认运行时边界由 `dataPath=<cwd>/data` 统一管理：

```text
data/
├─ content/                  # 用户应备份、审查、版本控制的 MDX 源文件
├─ knowledge/                # 可选 TDB 源文件
├─ memoria/
│  ├─ memory.sqlite           # 主引擎 SQLite 权威状态
│  └─ indexes/                # 主引擎派生向量索引
└─ tdb/
   ├─ knowledge.sqlite        # TDB SQLite 权威状态
   └─ indexes/                # TDB 派生向量索引
```

推荐的原始文档格式是带 YAML front matter 的 `.mdx`：

```mdx
---
title: 手冲咖啡
tags: [咖啡, 生活记录]
recordedAt: 2026-08-08T09:30:00-06:00
source: personal-journal
---

# 正文

正文内容。MDX/JSX 仅按 UTF-8 文本处理，不会被执行。
```

文件系统 adapter 只对大小写不敏感的 `.mdx` 解析 front matter；`.md` 和逻辑文档
仍按原始内容处理。`tags` 进入现有标签流水线，其他键写入 `files.metadata_json`；
front matter 在分块和嵌入前剥离。正文向量与 body checksum 绑定，而 adapter 另以
完整原始源文件计算 `revision`，因此 front matter 变化可以复用已有正文向量并执行
metadata/tag 更新；`.md` 不会因为正文中的 `---` 被误解析。

SQLite 是可查询的元数据、块正文、标签和持久向量 BLOB 权威；`.usearch` 文件是
按 diary/tag 命名的派生缓存。索引可以删除或在缺失、损坏、维度不符时从 SQLite
重建，不能把索引文件当作唯一备份。

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
- **加载开关**：`VexusVectorStore` 的 `indexLoadEnabled` 默认开启；设为 `false`
  时跳过磁盘读回并走 SQLite 重建。它是 vector-store 配置项，不是
  `DEFAULT_CONFIG` 中的必填默认字段。

## 4. 摄入时序：SQLite 先写，向量后写

`ingest(document)`、`ingestBatch(documents)` 是内容中心入口；`flushBatch(files)`
保留文件快照兼容面。两者都逐条跑 IngestPipeline，两个写入 stage 依次落库：

```
flushBatch → … → MetadataWriterStage（SQLite 写）→ VectorIndexerStage（Rust 写）
```

1. **SQLite 写**（metadata-writer.ts）：
   内置 `SqliteMetadataStore` 暴露 `replaceDocumentState()` 时，stage 先准备
   序列化 rows，再用一个 SQLite transaction 原子完成 file upsert、旧 chunks
   替换、tags upsert、`file_tags` 重建与 generation/dirty 更新。旧 chunk id 在
   transaction 内采集并返回为 `removedChunkIds`，供下一步清理向量索引。
   仅标签变化且不重建 chunks 时，内置 store 使用可选的
   `replaceDocumentTags()` 在一个 transaction 中更新 file metadata、tags、
   `file_tags` 和 generation/dirty，并保留旧 chunks。缺少该能力时在写入前抛出
   `configuration` 错误，不执行非原子多步写入；其他不涉及标签的旧兼容路径仍可使用。
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

   `persistTagIndex=true` 时 `global_tags` 按上述延迟持久化并在 clean restore 时加载；
   `false` 时不保存该索引，旧 `.usearch`/旁车文件保留但被忽略，恢复阶段从 SQLite
   authority 重建内存标签索引。

**关闭时序**（engine.ts）：`close()` 等待 keyed mutation queue，先
`flushPendingSaves()`，仅在 flush 成功且 vector state 完整时调用
`markVectorStateClean()`，最后关闭 metadata store。`flushPendingSaves`
（vexus-vector-store.ts）的语义是**保存当前内存中所有已加载索引 + 清空全部
定时器**（不只是“有定时器”的索引）；任一保存失败会向 Engine 传播，不能标记
clean，并使 `close()` 抛 `MemoriaError("lifecycle", ...)`。内置
`SqliteMetadataStore.close()` 只有 `db.close()` 成功后才设置 `_closed=true`；关闭
失败保留可重试状态。生产停机挂钩：`knowledge-base-adapter.shutdown()` =
`engine.close()`（compat/knowledge-base-adapter.ts:113–115）。

## 5. generation/dirty recovery 与权威重建

`MemoryEngine.initialize()` 先读取 SQLite `kv_store` 中的：

- `memoria.metadata_generation`
- `memoria.vector_generation`
- `memoria.vector_dirty`

当 `vector_dirty=0` 且两个 generation 相等时，走 clean fast path：从 SQLite
一次读取 expected index names，调用 `restorePersistedIndexes()`。Vexus 会对每个
预期名称检查 `.usearch` 文件、`.meta.json` dimension、native stats dimension，
并调用 `VexusIndex.load()`；所有 index 成功后才把临时 Map 原子提交到
`this.indices`。因此 clean reopen 后 search 直接使用已注册的内存 index，search
本身不负责隐式读盘，也不会把“验证成功但 Map 为空”当作成功。

以下任一条件都会进入全量 rebuild：dirty、generation mismatch、预期文件缺失、
loader 异常、metadata/native dimension 不匹配，或 `indexLoadEnabled=false`：

1. 如果 vector store 暴露 `rebuildDerivedState(plan)`，引擎把已校验的 authority
   plan 交给它完成原子重建；否则必须同时提供 `resetDerivedState()` 和
   `replaceIndex()`。缺少完整能力时直接抛出 `configuration`/完整性错误并保持
   dirty，禁止用逐项 `add` 假装恢复成功。内置 Vexus 路径会先取消 save timers、
   清空内存 index，并仅删除 `storePath` 根目录下符合
   `index_[0-9a-f]{32}.usearch` 及其 `.meta.json` 的 Memoria 文件；不递归删除其他
   文件。这样 SQLite authority 已删除的 diary 不会留下可在未来同名重建时复活的
   ghost vectors。
2. 通过 `getIndexableChunks()` 的一次 bulk query 读取 `chunks JOIN files`，再读取
   `getAllTags()`；解码有效 BLOB 后按 diary/global_tags 分组，调用
   `replaceIndex()` 重建全部 expected indexes。
3. 强制 `flushPendingSaves()`，成功后才把
   `vector_generation = metadata_generation`、`vector_dirty=0`。任何 rebuild 或
   save 失败都保持 dirty，并使 initialize 失败；不能宣称 ready。

第三方 vector store 只能选择实现完整的 `rebuildDerivedState(plan)`，或同时实现
`resetDerivedState()` 与 `replaceIndex()`；不再接受缺少严格 reconciliation 能力的
fallback。MetadataStore 仍可用逐行 authority 读取作为旧兼容路径，但 tag-only
更新必须提供 `replaceDocumentTags()`。

逻辑文档以 `document_id` 唯一识别；`revision` 相同且内容摘要不变时摄入幂等，
revision 或 content 改变时替换同一 files 行及其 chunks。`remove(documentId)` 不依赖
原始文件路径。

## 6. 索引加载边界（getOrCreateIndex 与 clean restore）

`getOrCreateIndex(indexName)` 只服务于写入时创建/取得一个内存索引；它仍可在
兼容写路径发现旧文件时尝试 `VexusIndex.load()`，失败则创建新空索引。它不是
initialize 的 recovery authority，也不是 search 的隐式加载机制。`search()` 只查
已在 `VexusVectorStore.indices` 中的 index；clean initialize 已通过 restore
把它们注册，rebuild 则从 SQLite 重新生成。

`restorePersistedIndexes()` 在 `indexLoadEnabled=false` 时直接返回 false，确保
系统改走 SQLite rebuild。验证采用临时 Map，任一 index 失败都不会提交该轮临时
加载结果，也不会修改已有 Map。对应回归覆盖 clean close → reopen 的真实向量 recall、
多 index 原子提交和禁用磁盘加载。

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

任一步失败都会清理临时文件并把错误上抛（:357–359 / :365–367 / :373–375）。
定时保存会记录错误；生命周期 `flushPendingSaves()` 会重新尝试所有已加载索引，
并把失败传给 Engine，阻止 clean mark 与成功 close。

## 8. 真实页面布局示例

离线演示读取 `data/content/**/*.mdx`，生成状态位于 `data/memoria/demo/`：

```
data/
├─ content/
│  ├─ life/coffee.mdx
│  ├─ memory/cold-knowledge.mdx
│  └─ quantum/qubit.mdx
└─ memoria/demo/
   ├─ memory.sqlite              # SQLite 主库（WAL 模式，运行期伴生 -wal/-shm）
   └─ indexes/
      ├─ index_<md5(diary)>.usearch
      └─ index_<md5(global_tags)>.usearch
```

- 文件名为 `index_<md5(diaryName)>.usearch`，即 §3 的命名规则；
- demo 使用独立的 `data/memoria/demo/`，不会清空或覆盖宿主默认的
  `data/memoria/memory.sqlite`；
- 向量 + 元数据重启恢复的完整验证路径：`tests/integration/real-dashscope.test.ts:253`
  （真实嵌入下的落盘 + 重开搜索）。

## 9. 清理注意事项

- **临时索引残留**：崩溃/杀进程可能留下
  `.{文件名}.tmp.*` / `.{文件名}.bak.*` sidecar（lib.rs:148–166 的
  tmp/bak role）。Rust 正常路径失败即删 temp、成功删 bak，但
  kill -9 / 断电不会清理。建议在引擎停机的维护窗口删除
  `storePath` 下匹配 `.*\.(tmp|bak)\..*` 的侧车文件（保留 `index_*.usearch`）。
- **WAL 伴生文件**：`memory.sqlite-wal` / `-shm` 是 SQLite WAL 的正常
  组成部分，删除会丢未检查点数据；仅在主库文件完整迁移时同批带走。
- **双写一致性**：`.usearch` 是可重建缓存；删除 `storePath` 下的索引而保留
  SQLite 是可恢复的维护动作，重启/初始化会从 SQLite authority 重建。若同时
  删除 `dbPath`，才代表连同权威元数据一起清空；维度更换时应使用新
  `storePath` 与 SQLite 文件并重新 `flushBatch`（见 [EMBEDDING.md](EMBEDDING.md) §5）。
- **定时器**：不调 `close()` 而直接退出进程，`scheduleIndexSave` 的
  定时器可能未到期，最后几批向量丢失。优雅停机务必走
  `engine.close()` / `adapter.shutdown()`。

## 10. TDB 冷知识库（简要）

`src/tdb/` 复用同一套持久化约定：`TDBStore`（better-sqlite3，`files`
表以 `(library, path)` 唯一、`chunks` 存 `library/path`、节点 id 与 `vector BLOB`）
＋ `VexusVectorStore`（storePath 取 `config.tdbStorePath`）。TDB 的 `chunks.vector`
列通过幂等 migration 添加；旧库中 vector 为空的行会在启动恢复时按 batch 重新嵌入，
并在维度、有限性和批次完整性校验通过后写回 SQLite。backfill 或索引应用失败时
`tdb.vector_dirty` 保持为 `1`，初始化失败，不会把引擎标记为 ready。clean generation
且所有 persisted index 可恢复时，TDB 直接调用 `restorePersistedIndexes()`；否则从
SQLite vector authority 计划并重建。close 前仍会 flush，并只在向量状态完整时标记
TDB generation clean。
