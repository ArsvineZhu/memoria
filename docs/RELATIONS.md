# 关系图与文件源

`memoria` 把用户的文件和系统为了检索而建立的关系分成两层：

```text
data/content/**/*.mdx       用户源文件，用户和 Git 的权威
        │ 静态读取
        ▼
data/memoria/memory.sqlite  文件、块、标签、来源关系、派生关系和代际
        │ 可重建/可缓存
        ├─ data/memoria/indexes/       向量索引
        └─ SQLite 中的 Memo artifact   TagMemo/Topology 的派生图资产
```

源文件不可变是库的边界，不是说关系不可变。用户可以修改源文件；库只把新快照
解析为新的来源关系，并把旧来源关系标为 `stale`。系统推断的关系写在独立的关系
表中，可以重新计算、停用或拒绝，不会回写 MDX。

## 文件如何进入库

```ts
import { createMemoryEngine } from "memoria";
import FilesystemIngestionAdapter from "memoria/adapters/filesystem";

const engine = createMemoryEngine({
  config: { dataPath: "./data", dimension: 1024 },
  embeddingProvider,
});
await engine.initialize();

const files = new FilesystemIngestionAdapter(engine, {
  rootPath: "./data/content",
  extensions: [".mdx", ".md"],
});

await files.sync(); // 首次扫描、更新和删除对账
await files.start(); // 后续 add/change/unlink 事件
// await files.close();
```

适配器只读取文件并把完整快照交给 `MemoryEngine.flushBatch()`。它会检查路径是否
仍在 root 下，并在读取前后确认文件没有变化；它不会把标签、辅助链接或任何结果
写回源文件。`MemoryEngine.ingest({ id, content, metadata })` 仍可用于没有文件路径
的逻辑文档。

MDX 的 front matter 会进入文件 metadata，`tags` 进入标签索引，正文进入块和向量。
正文中的以下静态关系会被提取：

- 普通 Markdown 链接，如 `[结果](../data/content/life/coffee.mdx#section)`；
- `[[other.mdx]]` wikilink；
- HTML `<a href="...">`；
- 允许列表中的字面量 `<MemoryLink target="..." />`。

解析器不执行 JSX、`import`、表达式或任意 MDX 组件。查询也始终是普通字符串；
这里的 MDX 只属于“记忆源的静态读取”，不是查询语言。

## 关系记录

SQLite `memory_relations` 表对应公开的 `MemoryRelationRecord`：

| 字段                            | 含义                                                    |
| ------------------------------- | ------------------------------------------------------- |
| `from` / `to`                   | `path:<relative-path>` 或 `document:<id>` 逻辑节点      |
| `kind`                          | `explicit-link`、`derived-link`、`tag`、`sequence`      |
| `origin`                        | `source` 是用户源文件显式关系，`derived` 是系统辅助关系 |
| `confidence` / `weight`         | 推断可信度和图计算权重，均在存储边界归一化              |
| `evidence` / `provenance`       | 产生关系的证据、参数或作业信息                          |
| `sourceRevision` / `sourceSpan` | 来源快照和源文本位置；用于审计与失效                    |
| `targetAnchor`                  | 链接中的 `#anchor`，保留直接锚点信息                    |
| `algorithmVersion`              | 派生关系算法版本                                        |
| `status` / `active`             | `active`、`stale`、`rejected` 生命周期                  |

来源链接拥有 `origin: "source"` 和完整源 revision。派生链接必须带有可追溯的
证据、算法版本和置信度；它不能覆盖来源链接的优先级。

## 写入和重建派生关系

来源关系一般由摄入管线维护。需要由外部作业写入辅助关系时，使用关系图 facade：

```ts
import { RelationGraphStore, relationDocumentKey } from "memoria";

const graph = new RelationGraphStore(engine.metadataStore);
await graph.addDerivedRelations([
  {
    from: relationDocumentKey({ path: "research/a.mdx" }),
    to: relationDocumentKey({ path: "research/b.mdx" }),
    kind: "derived-link",
    confidence: 0.82,
    weight: 0.7,
    evidence: "同一实验批次与引用链",
    provenance: { job: "association-v1", input: "search-feedback" },
    sourceRevision: null,
    algorithmVersion: "association-v1",
    sourceSpan: null,
    targetAnchor: null,
    active: true,
  },
]);
```

`RelationGraphStore.relatedDocumentKeys(starts, maxHops)` 和
`relatedChunks(seedChunkIds, maxHops, maxAdded)` 都是有界遍历。显式来源边优先于
派生边；关系更新会增加 relation generation，使 Rust Memo artifact 在下一次查询
前重建或复用正确代际。向量索引不需要因为单独的关系更新而被误标为脏。

关系扩展不是权限绕过：检索 scope 会在关系遍历前限制种子和新增块，管线末端还会
再次执行最终候选过滤。`filters.spaces: []` 是明确的空范围，会得到空结果。

## 备份和修改规则

- 要备份用户知识，优先备份 `data/content/`；它是可读、可版本控制的源。
- `memory.sqlite` 保存可审计的来源/派生关系和索引事实，应与源文件一起备份以保留
  反馈历史；缺失的向量索引和 Memo artifact 可以从 SQLite 重建。
- 不要手工编辑 `memory_relations` 来替代公开 facade；需要撤销推断时写入
  `active: false` 或 `status: "rejected"`，保留证据记录。
- 删除或重命名文件时让 `FilesystemIngestionAdapter.sync()` 或 `handleDelete()` 对账，
  不要由检索结果反向改动源目录。
