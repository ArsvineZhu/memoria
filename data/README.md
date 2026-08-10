# data 目录说明

`data/` 是项目管理源文件和运行状态的边界。源文件可以备份、审查和版本控制；
数据库和向量索引由程序生成，可以从源文件或 SQLite 重建。

```text
data/
├─ content/                  # 主引擎源文件，推荐使用 .mdx
│  ├─ life/
│  ├─ memory/
│  └─ quantum/
├─ knowledge/                # 可选的 TDB 源文件
├─ memoria/
│  ├─ memory.sqlite           # 主引擎元数据和正文数据库
│  └─ indexes/                # 主引擎生成的向量索引
└─ tdb/
   ├─ knowledge.sqlite        # TDB 数据库
   └─ indexes/                # TDB 生成的向量索引
```

## MDX 源文件

文件可以以 YAML front matter 开头：

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

正文内容。这里的 MDX/JSX 只按文字读取，不会被 memoria 执行。
```

规则如下：

- `tags` 会进入现有的标签处理流程；
- 其他 front matter 字段会保存到文件 metadata，并出现在搜索结果中；
- front matter 会在分块和嵌入前移除；
- 只改 front matter 时，可以复用正文向量并只更新 metadata；
- 没有 front matter 的 `.md` 文件仍然兼容。

## 备份和清理

SQLite 中的文件、正文、标签和向量 BLOB 是可查询的权威数据；`.usearch` 向量文件
是派生缓存，可以从 SQLite 重建，不能单独作为备份。

`data/content/**/*.mdx` 应纳入备份和代码审查。`data/memoria/` 与 `data/tdb/` 是
运行时输出，已被 Git 忽略，不要手工编辑。SQLite 使用 WAL 时，`.sqlite-wal` 和
`.sqlite-shm` 必须与主库一起备份；删除它们可能丢失尚未检查点的数据。

路径如何由 `dataPath` 派生、如何覆盖，以及索引恢复的具体过程，见
[../docs/CONFIGURATION.md](../docs/CONFIGURATION.md) 和
[../docs/PERSISTENCE.md](../docs/PERSISTENCE.md)。
