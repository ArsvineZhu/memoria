# MDX Data Layout and Persistent Runtime State Design

## Goal

Make `data/` the default host-owned boundary for memoria: MDX files are the
human-maintained source of truth, while SQLite and vector indexes live in
explicit generated-state directories. The change must preserve the existing
public search result contract and keep the evaluation corpus separate.

## Current-state constraints

- The main engine stores file metadata, chunk text, tags, and embedding BLOBs
  in SQLite; Vexus `.usearch` files are derived indexes keyed by SQLite IDs.
- The default SQLite path is currently `:memory:` and the default vector path
  is a top-level `VectorStore/`; both are unsuitable as the application default
  for a durable memory library.
- `eval/recall-benchmark` is a regression corpus, not production source data or
  a runtime cache, and must not be migrated or deleted.
- No new SQLite tables, persistence interfaces, Rust bindings, or VCP
  dependencies are introduced.

## Chosen layout

```text
data/
├─ content/                         # canonical MDX source files
│  ├─ life/
│  ├─ memory/
│  └─ quantum/
├─ knowledge/                       # optional TDB source files
├─ memoria/                          # main engine generated state
│  ├─ memory.sqlite
│  └─ indexes/
├─ tdb/                              # TDB generated state
│  ├─ knowledge.sqlite
│  └─ indexes/
└─ README.md                         # ownership, MDX and backup policy
```

`dataPath` is the single configurable root. Unless explicitly overridden,
`rootPath`, `storePath`, `dbPath`, `tdbRootPath`, `tdbStorePath`, and
`tdbDbPath` are derived from it. Explicit legacy path overrides continue to
win, so existing consumers can migrate incrementally.

The SQLite providers create the parent directory for a file-backed database.
The `:memory:` sentinel remains supported for tests and explicitly ephemeral
callers, but is no longer the default.

## MDX source contract

Every canonical source document is UTF-8 `.mdx` with optional YAML front
matter:

```mdx
---
title: 手冲咖啡
tags:
  - 咖啡
  - 生活记录
recordedAt: 2026-08-08T09:30:00-06:00
source: personal-journal
status: active
---

# 正文

这里是可检索的记忆正文。
```

Rules:

1. `tags` is the only reserved field consumed by the tag pipeline. It accepts
   a string or a string array and is normalized through the existing blacklist,
   length, date, and maximum-count rules.
2. All other front matter fields remain JSON-compatible metadata and are
   merged into `documentMetadata`, persisted in `files.metadata_json`, and
   exposed by the existing formatter as `SearchResult.metadata`.
3. The front matter is removed before chunking and embedding. Markdown headings
   and MDX JSX/import syntax remain text; memoria does not execute MDX.
4. Diary/index ownership continues to come from the first relative directory
   segment (`content/life/note.mdx` -> `life`). A front matter `diary` field is
   metadata only, avoiding path/index identity ambiguity.
5. Files without front matter and legacy `.md` files remain readable. The
   parser only activates when a document begins with a valid front matter
   delimiter.

The parser uses the `yaml` package instead of implementing a partial YAML
grammar. Invalid front matter is an ingestion error with the source path in
the message; it must not silently turn structured metadata into正文 text.

## Ingestion flow

```text
filesystem adapter
  -> FileReaderStage
     -> parse leading MDX front matter
     -> persist body as content and merged metadata
  -> TagExtractorStage
     -> tags from front matter + legacy trailing Tag: lines
  -> chunker / embedders / SQLite writer / vector indexer
```

The file reader keeps the existing checksum contract for plain files. For a
front-matter document it uses the body checksum for embedding reuse, while
`metadata_json` comparison still detects front-matter-only changes and routes
them through the metadata-only update path. This avoids paying for a new
embedding when only `title`, `tags`, or another metadata field changes.

## Cleanup and migration policy

- Convert the three generated demo source notes to `.mdx` under
  `data/content/{quantum,memory,life}` and update the demo to use the new
  source/state paths.
- Rebuild demo SQLite/index state from those MDX sources; do not carry forward
  stale indexes whose IDs/checksums refer to the old `notes/*.md` layout.
- Remove only the exact known generated cache directories after verifying they
  contain no source documents: the worktree/root `VectorStore/`, old demo
  `examples/demo/demo-data/` generated state, and the empty legacy
  `VectorStoreTDB/`/`knowledge/` roots. Do not touch `eval/`, source, tests, or
  user-authored content outside the migration targets.
- Add `data/memoria/`, `data/tdb/`, and runtime backup/temp patterns to
  `.gitignore`, while keeping `data/content/**/*.mdx` trackable.
- Keep SQLite WAL/SHM files with the database during backup; indexes are
  rebuildable but are kept for fast reopen when present.

## Verification

- Unit tests cover path derivation, file-backed parent creation, front matter
  parsing, metadata-only re-ingestion, front matter tags, malformed front
  matter, and legacy plain Markdown compatibility.
- Demo verification proves that source files are `.mdx`, state is beneath
  `data/`, search still hydrates tags and metadata, and no root-level
  `VectorStore/` is recreated.
- Run `corepack pnpm test`, `corepack pnpm typecheck:public`, and
  `corepack pnpm lint`; verify the final artifact inventory explicitly.
