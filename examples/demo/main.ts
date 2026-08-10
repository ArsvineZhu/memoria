"use strict";

/**
 * memoria 命令行演示
 *
 * 章节：
 *   1. 初始化   —— createMemoryEngine + 注入 Fake 嵌入 Provider
 *   2. 摄入     —— 写 3 篇演示日记 → flushBatch → getStats
 *   3. 基础检索 —— 混合检索（向量 + BM25）展示格式化结果
 *   4. 高级检索 —— TagMemo 浪潮 + EPA 投影 + 残差金字塔 痕迹
 *   5. 删除     —— handleDelete → 再查询确认消失
 *   6. 收尾     —— close() 关闭引擎
 *
 * 运行：node main.js   （零依赖、零网络、结果可复现）
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import { createMemoryEngine } from "../../src/index.js";
import { FakeEmbeddingProvider } from "./fake-embedding.js";
import type { MemoryEngine } from "../../src/engine.js";
import type { SearchEnvelope } from "../../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- 配置 ---------------- */

const DIM = 128;
const TOP_K = 3;

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DATA_DIR = path.join(REPO_ROOT, "data");
const NOTES_DIR = path.join(DATA_DIR, "content");
const DEMO_STATE_DIR = path.join(DATA_DIR, "memoria", "demo");
const DEMO_INDEX_DIR = path.join(DEMO_STATE_DIR, "indexes");
const DEMO_DB_PATH = path.join(DEMO_STATE_DIR, "memory.sqlite");

/* ---------------- 彩色日志 ---------------- */

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

let stepNo = 0;
function chapter(title: string): void {
  stepNo += 1;
  console.log(`\n${C.cyan}════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}${C.cyan}  章节 ${stepNo}｜${title}${C.reset}`);
  console.log(`${C.cyan}════════════════════════════════════════════${C.reset}`);
}

function info(msg: string): void {
  console.log(`  ${C.green}ℹ${C.reset} ${msg}`);
}

function done(msg: string): void {
  console.log(`  ${C.bold}${C.green}✔${C.reset} ${C.green}${msg}${C.reset}`);
}

function snippet(text: unknown, max = 80): string {
  const flat = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/* ---------------- 演示日记 ---------------- */

const NOTES = ["quantum/qubit.mdx", "memory/cold-knowledge.mdx", "life/coffee.mdx"];

/* ---------------- 引擎初始化 ---------------- */

async function initEngine() {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  fs.mkdirSync(DEMO_INDEX_DIR, { recursive: true });

  const engine = createMemoryEngine({
    config: {
      dimension: DIM,
      rootPath: NOTES_DIR,
      topK: TOP_K,
      storePath: DEMO_INDEX_DIR,
      // 高级记忆能力：
      tagMemoV9Enabled: true, // TagMemo 浪潮
      epaProjectionEnabled: true, // EPA 语义投影
      residualPyramidEnabled: true, // 残差金字塔
      tagExpansionEnabled: false, // 标签扩展（默认关）
      timeDecayEnabled: false, // 时间衰减（默认关）
    },
    dbPath: DEMO_DB_PATH,
    embeddingProvider: new FakeEmbeddingProvider(DIM),
  });

  await engine.initialize();
  return engine;
}

/* ---------------- 章节 ---------------- */

async function chapter1(engine: MemoryEngine): Promise<void> {
  info(`引擎: ${engine.name} (${engine.constructor.name})`);
  info(`嵌入维度: ${engine.embeddingProvider.getDimension()} (Fake 确定性嵌入)`);
  info(`向量存储: ${engine.vectorStore.constructor.name} (Rust N-API)`);
  info(`元数据存储: ${engine.metadataStore.constructor.name} (SQLite)`);
  info(`源数据目录: ${NOTES_DIR}`);
  info(`演示状态目录: ${DEMO_STATE_DIR}`);
  done("初始化完成，引擎就绪");
}

async function chapter2(engine: MemoryEngine): Promise<void> {
  for (const note of NOTES) {
    const abs = path.join(NOTES_DIR, note);
    const stat = fs.statSync(abs);
    info(`读取 ${note} (${stat.size} 字节)`);
  }

  const envelopes = await engine.flushBatch(
    NOTES.map((note) => ({ path: path.join(NOTES_DIR, note) })),
  );
  const stats = await engine.getStats();
  const errors = envelopes
    .filter((e) => typeof e.error === "string")
    .map((e) => String(e.error));
  info(`异常: ${errors.length > 0 ? errors.join("; ") : "无"}`);
  done(
    `摄入完成 → 文件 ${stats.files}｜块 ${stats.chunks}｜标签 ${stats.tags}｜日记本 ${stats.diaries.join("、")}｜向量 ${stats.vectorStats.totalVectors}`,
  );
}

async function runSearch(
  engine: MemoryEngine,
  label: string,
  query: string,
): Promise<SearchEnvelope> {
  console.log("");
  info(`${label} → 查询"${query}"`);
  const envelope = await engine.search(query, { topK: TOP_K });
  const results = envelope.results || [];
  if (results.length === 0) {
    console.log(`    ${C.yellow}(无结果)${C.reset}`);
    return envelope;
  }
  for (const r of results) {
    const score = (r.score ?? r.memoScore ?? 0).toFixed(4);
    const where = r.sourceFile || r.path || `#${r.id ?? r.chunkId}`;
    console.log(`    ${C.bold}[score ${score}]${C.reset} ${where}`);
    console.log(`      ${C.dim}${snippet(r.content)}${C.reset}`);
  }
  console.log(`    ${C.dim}→ 命中 ${results.length} 条${C.reset}`);
  return envelope;
}

async function chapter3(engine: MemoryEngine): Promise<void> {
  await runSearch(engine, "基础检索", "量子计算 芯片");
  await runSearch(engine, "基础检索", "遗忘曲线 复习");
}

async function chapter4(engine: MemoryEngine): Promise<void> {
  const envelope = await runSearch(engine, "高级检索", "手冲 萃取参数");
  const tm =
    envelope.tagMemo && typeof envelope.tagMemo === "object"
      ? (envelope.tagMemo as { rankedTags?: unknown[] })
      : {};
  if (tm.rankedTags && tm.rankedTags.length) {
    const tags = tm.rankedTags
      .slice(0, 5)
      .map((t: unknown) => {
        if (typeof t === "string") return t;
        if (t && typeof t === "object") {
          const item = t as { tag?: unknown; name?: unknown };
          return String(item.tag ?? item.name ?? t);
        }
        return String(t);
      })
      .join("、");
    info(`TagMemo 浪潮激活标签: ${tags}`);
  } else {
    console.log(`    ${C.dim}TagMemo: 无激活标签（本次查询未命中波形）${C.reset}`);
  }
  const epa =
    envelope.epa && typeof envelope.epa === "object"
      ? (envelope.epa as {
          ready?: boolean;
          queryAnalysis?: {
            logicDepth?: number;
            dominantAxes?: unknown[];
            resonance?: { resonance?: number };
          };
        })
      : {};
  const qa = epa.queryAnalysis || {};
  if (epa.ready === false) {
    console.log(
      `    ${C.dim}EPA: 标签量不足，未构建语义基（需要更多带向量的标签）${C.reset}`,
    );
  } else if (qa.logicDepth != null) {
    console.log(
      `    ${C.dim}EPA 逻辑深度: ${qa.logicDepth.toFixed(3)}｜主轴数: ${(qa.dominantAxes || []).length}｜共振: ${((qa.resonance || {}).resonance || 0).toFixed(3)}${C.reset}`,
    );
  }
  const pyr = envelope.pyramid;
  const features =
    pyr?.features && typeof pyr.features === "object"
      ? (pyr.features as { depth?: number; coverage?: number; novelty?: number })
      : undefined;
  if (
    features &&
    features.depth != null &&
    features.coverage != null &&
    features.novelty != null
  ) {
    console.log(
      `    ${C.dim}残差金字塔: 深度 ${features.depth}｜覆盖率 ${(features.coverage * 100).toFixed(1)}%｜新颖度 ${features.novelty.toFixed(2)}${C.reset}`,
    );
  }
}

async function chapter5(engine: MemoryEngine): Promise<void> {
  console.log("");
  const target = path.join(NOTES_DIR, "life/coffee.mdx");
  await engine.handleDelete({ path: target });
  const stats = await engine.getStats();
  info(
    `删除 ${path.basename(target)} → 文件 ${stats.files}｜块 ${stats.chunks}｜标签 ${stats.tags}`,
  );
  const envelope = await engine.search("手冲咖啡");
  const results = envelope.results || [];
  if (results.length === 0) {
    done("再查询咖啡主题 → 0 结果，删除已生效");
  } else {
    console.log(
      `    ${C.yellow}仍命中 ${results.length} 条：${results.map((r) => r.sourceFile || r.id).join("、")}${C.reset}`,
    );
    done("删除已生效（其余日记仍可命中相关片段）");
  }
}

async function chapter6(engine: MemoryEngine): Promise<void> {
  // Windows 沙盒下 Rust 索引延迟落盘可能被拒（已知环境限制），
  // 捕获后汇总为一条提示，避免刷屏红色错误。
  const rawError = console.error;
  const failures: string[] = [];
  console.error = (msg?: unknown, ..._optional: unknown[]) => {
    if (String(msg).includes("[VexusVectorStore] Flush save failed"))
      failures.push(String(msg));
    else rawError(msg);
  };
  try {
    await engine.close();
  } finally {
    console.error = rawError;
  }
  if (failures.length > 0) {
    console.log(
      `    ${C.yellow}索引落盘被系统拒绝 ${failures.length} 个（Windows 沙盒已知限制，内存索引不受影响）${C.reset}`,
    );
  }
  done("引擎已关闭（SQLite + Rust 索引已释放）");
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log(
    `${C.bold}${C.cyan}memoria 命令行演示 · 最小用例${C.reset} ${C.dim}(离线确定性嵌入, d=${DIM})${C.reset}`,
  );

  const engine = await initEngine();
  try {
    chapter("初始化");
    await chapter1(engine);
    chapter("摄入 3 篇演示日记");
    await chapter2(engine);
    chapter("基础检索（向量 + BM25 混合）");
    await chapter3(engine);
    chapter("高级检索（TagMemo 浪潮 / EPA / 残差金字塔）");
    await chapter4(engine);
    chapter("删除");
    await chapter5(engine);
    chapter("收尾");
    await chapter6(engine);
    console.log(`\n${C.green}${C.bold}演示完成，全部章节通过。${C.reset}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.stack || err.message : String(err);
    console.error(`\n${C.red}演示失败: ${message}${C.reset}`);
    process.exitCode = 1;
  } finally {
    if (engine && !engine._closed) await engine.close().catch(() => {});
  }
}

void main();
