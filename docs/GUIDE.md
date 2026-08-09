# GUIDE — 快速上手

> 面向接入方：从零开始安装、最小链路、配置速查、删除语义与指标说明。
> 所有字段名与默认值均摘自 `src/config/default-config.ts`，行为摘自 `src/engine.ts`；发布运行时使用 `dist/`。

## 1. 前置条件

- **Node.js ≥ 24.18.1 < 25**（当前 LTS；`fetch` / `AbortController` 为全局可用）
- **TypeScript 7.0.2**（源码构建与类型检查；发布包优先使用 `dist/` 的 ESM）
- **pnpm 11.20.0**（通过 Corepack 启用；依赖：`better-sqlite3`、`@dqbd/tiktoken`、`chokidar`）
- `corepack pnpm install --frozen-lockfile`（安装锁定依赖）
- `pnpm typecheck && pnpm build`（严格类型检查并生成 `dist/`）
- **Rust 向量引擎二进制**：`rust-vexus-lite/*.node` 随仓库分发（当前平台预编译），
  无需本地 Rust 工具链。仅在需要自行重建时执行：
  ```bash
  cd rust-vexus-lite && pnpm exec napi build --platform --release && cd ..
  ```
- 联网嵌入（可选）：`EMBED_API_KEY` 或直接在构造参数传 `apiKey`；离线伪嵌入不需要。

## 2. 最小链路（离线可跑，TypeScript + ESM）

以 `examples/demo/fake-embedding.ts` 的离线确定性嵌入为例——无需 API Key、无网络、
结果可复现。假设脚本与仓库根目录同级：

```ts
import { join } from "node:path";

import { createMemoryEngine } from "memoria";
import { FakeEmbeddingProvider } from "./dist-test/examples/demo/fake-embedding.js";

const root = process.cwd();

const engine = createMemoryEngine({
  config: {
    dimension: 128, // 必须与 Provider 维度一致
    rootPath: join(root, "notes"), // filesystem adapter 的扫描根目录
    storePath: join(root, "indices"),
    topK: 3,
  },
  dbPath: join(root, "memory.sqlite"),
  embeddingProvider: new FakeEmbeddingProvider(128), // 离线确定性伪嵌入
});

async function main(): Promise<void> {
  await engine.initialize(); // 加载 rag 参数、置就绪
  await engine.ingest({
    id: "demo:coffee",
    content: "今天手冲咖啡：水温 93 度左右，粉水比 1:15，浅烘焙豆子香气明亮。",
    revision: "1",
    metadata: { topic: "coffee" },
  });

  const stats = await engine.getStats();
  console.log(
    `已入库：文件 ${stats.files}｜块 ${stats.chunks}｜向量 ${stats.vectorStats.totalVectors}`,
  );

  const out = await engine.search("手冲 萃取参数", { topK: 3 });
  for (const r of out.results)
    console.log(`[${r.score}] ${r.documentId}: ${r.content}`);

  await engine.remove("demo:coffee");
  await engine.close();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

写好的文本文件示例（`notes/life/coffee.md`）：

```md
今天手冲咖啡：水温 93 度左右，粉水比 1:15，浅烘焙豆子香气明亮。

Tag: 咖啡, 生活记录 ← 文末连续 Tag: 行才会被提取（extractTags 规则）
```

零网络运行 `pnpm build:test && node dist-test/examples/demo/main.js` 可看 6 章节完整生命周期演示；本文等价链路
已实测通过（1 文件 → 1 块 / 2 标签 / 3 向量，检索与删除均生效）。

### 真实嵌入（DashScope / OpenAI 兼容）

```ts
import { join } from "node:path";

import { createMemoryEngine } from "memoria";
import DashScopeEmbeddingProvider from "./src/providers/dashscope-embedding-provider.js";

const engine = createMemoryEngine({
  config: { dimension: 1024 }, // 与 model 输出维度一致
  dbPath: join(process.cwd(), "memory.sqlite"),
  embeddingProvider: new DashScopeEmbeddingProvider({
    apiKey: process.env.EMBED_API_KEY ?? "",
    model: "qwen3.7-text-embedding",
    dimension: 1024,
  }),
});
```

详见 [EMBEDDING.md](./EMBEDDING.md)。

## 3. 配置速查表（`DEFAULT_CONFIG` 全字段）

### 路径类

| 字段        | 默认值              | 说明                                              |
| ----------- | ------------------- | ------------------------------------------------- |
| `rootPath`  | `process.cwd()`     | 相对路径基准；文件相对此目录计算并入库            |
| `storePath` | `<cwd>/VectorStore` | 向量索引持久化目录                                |
| `dbPath`    | `':memory:'`        | SQLite 元数据路径；构造时 `options.dbPath` 可覆盖 |

### 嵌入 Provider

| 字段             | 默认值                          | 说明                               |
| ---------------- | ------------------------------- | ---------------------------------- |
| `apiUrl`         | `''`                            | 嵌入 API 基础地址（OpenAI 兼容用） |
| `apiKey`         | `''`                            | Bearer 密钥                        |
| `model`          | `'google/gemini-embedding-001'` | 主嵌入模型                         |
| `modelSig`       | `'gemini-embedding-2-preview'`  | 模型签名（缓存失效用）             |
| `fallbackModels` | `[]`                            | OpenAI 兼容路径的失败回退链        |
| `maxBatchItems`  | `32`                            | 每请求最大条目数                   |
| `maxToken`       | `8000`                          | 单文本 token 上限（超限跳弃）      |
| `concurrency`    | `5`                             | 并行请求 worker 数                 |

### 向量存储

| 字段                | 默认值   | 说明                           |
| ------------------- | -------- | ------------------------------ |
| `dimension`         | `3072`   | 向量维度（Vexus 索引构造维度） |
| `tagIndexCapacity`  | `50000`  | 新建索引默认容量               |
| `indexSaveDelay`    | `120000` | 日记索引延迟保存（ms）         |
| `tagIndexSaveDelay` | `300000` | 标签索引延迟保存（ms）         |
| `persistTagIndex`   | `false`  | 是否持久化 global_tags 索引    |

### SQLite 元数据

| 字段             | 默认值  | 说明                      |
| ---------------- | ------- | ------------------------- |
| `busyTimeout`    | `10000` | SQLite busy_timeout（ms） |
| `busyRetryDelay` | `100`   | 忙重试间隔（ms）          |

### 摄入（chunking / 标签）

| 字段                                         | 默认值  | 说明                       |
| -------------------------------------------- | ------- | -------------------------- |
| `chunkMaxTokens`（别名 `maxTokens`）         | `600`   | 单块 token 上限            |
| `chunkOverlapTokens`（别名 `overlapTokens`） | `96`    | 相邻块重叠 token           |
| `tagBlacklist`                               | `[]`    | 标签黑名单（完全匹配剔除） |
| `tagBlacklistSuper`                          | `[]`    | 超集黑名单（正则删除）     |
| `maxTagsPerFile`                             | `50`    | 每文件最大标签数           |
| `cooccurrenceRebuild`                        | `false` | 摄入时触发共现矩阵重建     |
| `checkpoint`                                 | `false` | 是否写入 kv_store 检查点   |
| `checkpointInterval`                         | `1`     | 每 N 个文件写一次检查点    |

### 检索门（闸门）

| 字段                                           | 默认值  | 说明             |
| ---------------------------------------------- | ------- | ---------------- |
| `epaProjectionEnabled`                         | `true`  | EPA 语义深度信号 |
| `residualPyramidEnabled`                       | `true`  | 残差金字塔分解   |
| `tagMemoV9Enabled`                             | `false` | V9 波传播激活    |
| `tagMemoV10Enabled`                            | `false` | V10 双尺度场扩散 |
| `riverMemoEnabled`                             | `false` | 河流状态累计重排 |
| `tagExpansionEnabled`                          | `false` | 标签驱动候选扩展 |
| `vectorReshapeEnabled`                         | `false` | 余弦向量重排     |
| `externalRerankEnabled`（别名 `useLLMRerank`） | `false` | LLM/外部重排     |
| `timeDecayEnabled`                             | `false` | 时效衰减         |
| `truncateEnabled`                              | `false` | 结果截断         |
| `expansionEnabled`                             | `false` | 同文件关联块扩展 |

### 检索旋钮（topK / 权重 / 融合）

| 字段                               | 默认值          | 说明                                         |
| ---------------------------------- | --------------- | -------------------------------------------- |
| `topK`                             | `5`             | 最终返回数（融合后截断）                     |
| `perIndexK`                        | `null`          | 每索引候选数（缺省用 topK）                  |
| `indexNames`                       | `null`          | 显式索引名清单（优先于 diaryNames）          |
| `searchAllIndices`                 | `false`         | 搜索全部日记索引                             |
| `tagSearchEnabled`                 | `false`         | 标签索引查询 + 展开命中文件                  |
| `tagIndexName`                     | `'global_tags'` | 标签索引名                                   |
| `tagK`                             | `10`            | 标签索引每查询命中数                         |
| `queryExpansion`                   | `1`             | 查询文本变体数（>1 需 `rephraserFn`）        |
| `queryEpsilon`（别名 `epsilon`）   | `null`          | 查询向量近零掩码阈值                         |
| `rephraserFn` / `queryRephraserFn` | `null`          | 查询改述注入函数（库自身不调用 LLM）         |
| `stopWords`                        | `[]`            | BM25 停用词                                  |
| `tokenizer`                        | `null`          | 自定义分词器（默认 whitespace + CJK 二元组） |
| `bm25K1`                           | `1.5`           | BM25 词频饱和                                |
| `bm25B`                            | `0.75`          | BM25 长度归一化                              |
| `bm25PoolK`                        | `50`            | BM25 最多返回数                              |
| `minScore`                         | `0`             | 融合后最低保留分                             |
| `vectorWeight`                     | `0.7`           | 向量源权重（候选融合）                       |
| `bm25Weight`                       | `0.3`           | BM25 源权重                                  |
| `hybridAlpha` / `hybridBeta`       | `0.7` / `0.3`   | 融合权重别名（TDB 命名）                     |

说明：`candidateMerger` 内部取 `vectorWeight` 优先，未设置时回退 `hybridAlpha`，
再回退 0.6；`bm25Weight` 同理最后回退为 `1 - vectorWeight`。融合分 =
`vectorWeight × (vectorScore/向量源max) + bm25Weight × (bm25Score/BM25源max)`。

### 后处理

| 字段                                    | 默认值  | 说明                                  |
| --------------------------------------- | ------- | ------------------------------------- |
| `dedupeEnabled`                         | `true`  | 去重总门（stage 内部执行）            |
| `dedupeSemantic`                        | `true`  | 语义去重开关                          |
| `semanticThreshold`                     | `0.92`  | 语义近重复余弦阈值                    |
| `dedupeMaxResults`（别名 `maxResults`） | `1000`  | 去重后最大保留数                      |
| `minSemanticCandidates`                 | `2`     | 触发语义去重的候选下限                |
| `sourcePriority`                        | 见下    | 代表项选择来源优先级                  |
| `reranker`                              | `null`  | 外部排序器函数（externalReranker 用） |
| `timeDecayHalfLife`                     | `90`    | 分数半衰期（天）                      |
| `timeDecayNow`                          | `null`  | 时钟覆盖（测试确定性）                |
| `timeDecayUpperBound`                   | `null`  | 时间窗口上限（天）                    |
| `maxContentLength`                      | `800`   | 截断时内容长度上限（字符）            |
| `truncateEllipsis`                      | `false` | 截断追加 `…`                          |
| `expandCount`                           | `2`     | 扩展种子数                            |
| `expansionBoost`                        | `1.15`  | 扩展相似块分数倍率                    |

`sourcePriority` 默认值：`{ rag: 50, time: 45, bm25_body: 40, bm25_tag: 40,
continuity: 35, associate: 10, unknown: 0 }`（组合来源优先级，硬去重选代表用）。

### EPA / 金字塔 / V9 / V10 / River 专项

| 字段                                                                   | 默认值          | 说明                                                                |
| ---------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------- |
| `epaClusterCount`                                                      | `64`            | 基构建聚类数                                                        |
| `epaMaxBasisDim`                                                       | `64`            | 基最大维数                                                          |
| `epaPerCandidateAnalysis`                                              | `false`         | 逐候选 EPA 分析                                                     |
| `strictOrthogonalization`                                              | `true`          | 严格正交化（幂法）                                                  |
| `pyramidMaxLevels`（别名 `maxLevels`）                                 | `3` / `3`       | 残差金字塔层数上限                                                  |
| `pyramidTopK`                                                          | `5`             | 每层标签检索数                                                      |
| `pyramidMinEnergyRatio`（别名 `minEnergyRatio`）                       | `0.1`           | 残差能量比停止阈值                                                  |
| `maxSafeHops`                                                          | `4`             | 波传播最大跳数                                                      |
| `baseMomentum`（别名 `momentum`）                                      | `2.0` / `2.0`   | 基础动量                                                            |
| `firingThreshold`                                                      | `0.1`           | 发放阈值                                                            |
| `baseDecay`                                                            | `0.25`          | 每跳基础衰减                                                        |
| `wormholeDecay`                                                        | `0.7`           | 虫洞（共振）边衰减                                                  |
| `tensionThreshold`                                                     | `1.0`           | 虫洞判定张力阈值                                                    |
| `maxNeighborsPerNode`（别名 `branchLimit`）                            | `20` / `20`     | 每节点最多分支                                                      |
| `returnFlowFactor`                                                     | `0.15`          | 回传流量抑止系数                                                    |
| `firGamma`                                                             | `0.6`           | FIR 读出头脉冲响应 gamma                                            |
| `maxPropagationStates`（别名 `stateLimit`）                            | `2000` / `2000` | 传播状态上限                                                        |
| `pruneAbove`                                                           | `0`             | 按峰值比例剪枝（0=关）                                              |
| `localAlpha`                                                           | `0.15`          | V10 局部尺度 α                                                      |
| `transferAlpha`                                                        | `0.55`          | V10 迁移尺度 α                                                      |
| `localMaxIterations` / `transferMaxIterations` / `solverMaxIterations` | `200`           | 求解迭代上限                                                        |
| `solverTolerance`                                                      | `1e-9`          | 固定点收敛容差                                                      |
| `supportMethod`                                                        | `'mass_ratio'`  | 有效支撑方法（mass_ratio/shannon/participation_ratio/spectral_gap） |
| `localMassRatio` / `transferMassRatio`                                 | `0.8` / `0.9`   | 支撑保留质量比                                                      |
| `pruneByEnergy` / `minFieldEnergy`                                     | `false` / `0`   | 弱场条目剪枝                                                        |
| `riverDecay`                                                           | `1.0`           | 河流流逐 tick 衰减                                                  |
| `riverTopologyCap`                                                     | `0.08`          | 拓扑加成上限                                                        |

### TDB 冷知识库

| 字段                    | 默认值                           | 说明                   |
| ----------------------- | -------------------------------- | ---------------------- |
| `tdbEnabled`            | `false`                          | TDB 引擎总开关         |
| `tdbRootPath`           | `<cwd>/knowledge`                | 库解析根目录           |
| `tdbStorePath`          | `<cwd>/VectorStoreTDB`           | TDB 向量索引目录       |
| `tdbDbPath`             | `':memory:'`                     | TDB 元数据 SQLite      |
| `tdbModel`              | `'google/gemini-embedding-001'`  | TDB 嵌入模型           |
| `tdbDimension`          | `3072`                           | TDB 向量维度           |
| `tdbEmbeddingBatchSize` | `16`                             | TDB 嵌入分批           |
| `tdbExtensions`         | `['.md','.txt','.json','.html']` | 支持的扩展名清单       |
| `tdbExcludeFolders`     | `['TDBdocs']`                    | 排除目录               |
| `tdbSyncMode`           | `'normal'`                       | 本地适配器同步模式参数 |
| `tdbForceQuery`         | `null`                           | 强制查询模式（可留空） |
| `tdbHybridAlpha`        | `0.7`                            | TDB 融合向量权重       |
| `tdbTopK`               | `10`                             | TDB 默认 topK          |
| `tdbMinScore`           | `0.1`                            | TDB 最小得分           |
| `tdbExpandDepth`        | `1`                              | TDB 关键词扩展深度     |
| `tdbTimeDecayEnabled`   | `false`                          | TDB 时间衰减开关       |

TDB 搜索同样遵循 scope precedence：`libraries` 显式范围优先；未指定时检索所有
authoritative libraries。`chunks.vector` 是 SQLite authority 的持久向量列，旧库
缺失该列会幂等迁移；旧行缺向量时初始化执行一次完整性校验后的 backfill，失败会
保持 dirty 并使初始化失败。

## 4. 检索参数（search 调用面）

`engine.search(query, options)` 的 `options` 会扁平展开进查询载荷，常用：

- `topK` — 最终结果数
- `indexNames` / `diaryNames` / `diaryName` — 显式限定索引范围；vector、BM25 与 hydration 共用
- `indexNames` / `searchAllIndices` — 精细控制索引选择
- `tagSearchEnabled`、`tagK` — 标签召回
- 权重类（`vectorWeight` / `bm25Weight` / `hybridAlpha` / `hybridBeta`）、
  `minScore`、`timeDecayHalfLife` 等会话参数可直接覆盖

Scope precedence：显式 scope → 该 scope；无显式 scope → SQLite authority 发现的全部
内容索引；只有 scope discovery 不可用时才回退到 `Root`。无 scope 时不再默认只查
`Root`。`timeDecay` 的唯一执行者是 `TimeDecayStage`：`timeDecayEnabled=false`
执行零次，启用时执行一次。

返回信封：

```ts
{
  query, queries: [{ text, vector }],
  vectorResults, bm25Results, mergedCandidates,
  epa?, pyramid?, tagMemo?, riverMemo?,          // 记忆信号（开相应门时出现）
  results: [ { id, chunkId, content, path, sourceFile, fileId,
               diaryName, score, similarity, updatedAt, mtime,
               tags, matchedTags, memoScore?, source, decay?, rerankScore? } ],
  resultCount
}
```

`content` 缺省为完整块文本；`sourceFile` 为 basename，`path` 为存储的相对路径。

## 5. 删除 / 清空语义

- `handleDelete({ path })` / `engine.deleteFile(filePath)`：删除**单文件**
  文件行 + 块行（FK 级联）+ 该日记索引中的块向量；**标签行与 global_tags 索引
  不受影响**（标签跨文件共享）。幂等：未知路径返回 `{ deleted: false }`。
- 返回信封：`{ deleted, fileId, removedChunkIds }`。
- 全量清空：无一次性 API——遍历历史文件逐个 `handleDelete`，然后删除
  `storePath` 目录中的持久化索引与 SQLite 文件（或直接换新 storePath/dbPath）。

## 6. 指标（getStats 真实字段）

```ts
const stats = await engine.getStats();
// {
//   files:        number,        // files 表行数（无原始表时按 chunk 去重估算）
//   chunks:       number,        // chunk 行数
//   tags:         number,        // 标签行数
//   diaries:      string[],      // 去重后的日记名列表
//   lastIndexed:  number|null,   // 最近一次入库时间（毫秒；无则 null）
//   vectorStats:  { totalVectors, indices, dimension },  // 向量总数/索引数/维度
//   healthy:      { healthy, issues[] },   // SQLite 健康探针
//   initialized:  boolean
// }
```

注意 `vectorStats.totalVectors` = 所有日记索引 + global_tags 的向量总数
（块向量 + 标签向量都会计入）。

## 7. 常见场景：更换 Provider 与维度同步

1. **维度必须一致**：`config.dimension` 必须等于
   `embeddingProvider.getDimension()`；Mismatch 时 DashScope 组会整条丢弃
   （`_asToFloat32Array` 校验），去重器也会丢弃长度不符的向量。
2. **换 Provider / 改维度后**：旧库无法复用——使用新 storePath 与新的
   SQLite 文件（或删旧文件），然后对全部文档重新 `flushBatch`。
3. `close()` 后再启动：懒加载索引从磁盘恢复；维度不匹配的持久化索引在 load
   时即报错并重建为新空间。

验证视角：`tests/engine/test-engine.test.ts` 覆盖生命周期与删除语义；
`tests/providers/` 覆盖存储与嵌入 Provider；`tests/integration/verify.ts`
是 KBM 组合冒烟（离线 4 维）。
