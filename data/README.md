# memoria data

`data/` is the managed boundary for source documents and generated runtime
state.

```text
data/
├─ content/                  # canonical MDX source documents; back up this
│  ├─ life/                  # directory as user data
│  ├─ memory/
│  └─ quantum/
├─ knowledge/               # optional TDB source documents
├─ memoria/
│  ├─ memory.sqlite          # generated metadata authority
│  └─ indexes/               # generated vector indexes and sidecars
└─ tdb/
   ├─ knowledge.sqlite       # generated TDB metadata
   └─ indexes/               # generated TDB vector indexes
```

MDX is the canonical source format for filesystem ingestion. A document may
start with YAML front matter:

```mdx
---
title: 手冲咖啡
tags:
  - 咖啡
  - 生活记录
recordedAt: 2026-08-08T09:30:00-06:00
source: personal-journal
---

# 正文

正文内容。这里的 MDX/JSX 只作为文本读取，不会被 memoria 执行。
```

`tags` is consumed by the existing tag pipeline. Other front-matter keys are
stored in the file metadata JSON and exposed through hydrated result metadata.
The front matter is removed before chunking and embedding. A change limited to
front matter reuses the body embedding and performs a metadata-only update.

SQLite rows are the metadata/content authority. Vector indexes are a cache-like
derived artifact: they may be rebuilt from SQLite and should not be edited by
hand. `data/memoria/` and `data/tdb/` are runtime output and are ignored by
Git; `data/content/**/*.mdx` remains trackable and is the part to back up and
review.
