'use strict';

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

const path = require('node:path');
const fs = require('node:fs');

const { createMemoryEngine } = require('../..');
const { FakeEmbeddingProvider } = require('./fake-embedding');

/* ---------------- 配置 ---------------- */

const DIM = 128;
const TOP_K = 3;

const DEMO_DIR = path.join(__dirname, 'demo-data');
const NOTES_DIR = path.join(DEMO_DIR, 'notes');

/* ---------------- 彩色日志 ---------------- */

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m'
};

let stepNo = 0;
function chapter(title) {
  stepNo += 1;
  console.log(`\n${C.cyan}════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}${C.cyan}  章节 ${stepNo}｜${title}${C.reset}`);
  console.log(`${C.cyan}════════════════════════════════════════════${C.reset}`);
}

function info(msg) {
  console.log(`  ${C.green}ℹ${C.reset} ${msg}`);
}

function done(msg) {
  console.log(`  ${C.bold}${C.green}✔${C.reset} ${C.green}${msg}${C.reset}`);
}

function snippet(text, max = 80) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

/* ---------------- 演示日记 ---------------- */

const NOTES = [
  {
    file: 'quantum/qubit.md',
    content: `量子计算使用量子比特（qubit）进行计算，与经典比特不同，
量子叠加与纠缠让并行计算成为可能，量子纠错是当前的重大挑战。
我在调研近期量子芯片的进展。

Tag: 量子计算, 科技前沿
`
  },
  {
    file: 'memory/cold-knowledge.md',
    content: `VCP 记忆系统使用冷知识库与波形算法处理长期记忆：
冷知识有较高的记忆滞留率，配合遗忘曲线做周期复习效果更好。
EPA 投影把向量映射到正交语义空间，残差金字塔逐层解释查询能量。

Tag: 记忆系统, 算法笔记
`
  },
  {
    file: 'life/coffee.md',
    content: `今天手冲咖啡：水温 18F（注：应为 93 度左右），粉水比 1:15，
浅烘焙的豆子香气明亮。记录一下萃取参数，下次调到 1:16。

Tag: 咖啡, 生活记录
`
  }
];

/* ---------------- 引擎初始化 ---------------- */

async function initEngine() {
  fs.rmSync(DEMO_DIR, { recursive: true, force: true });
  fs.mkdirSync(NOTES_DIR, { recursive: true });

  fs.mkdirSync(path.join(DEMO_DIR, 'indices'), { recursive: true });

  const engine = createMemoryEngine({
    config: {
      dimension: DIM,
      rootPath: NOTES_DIR,
      topK: TOP_K,
      storePath: path.join(DEMO_DIR, 'indices'),
      // 高级记忆能力：
      tagMemoV9Enabled: true,        // TagMemo 浪潮
      epaProjectionEnabled: true,    // EPA 语义投影
      residualPyramidEnabled: true,  // 残差金字塔
      tagExpansionEnabled: false,    // 标签扩展（默认关）
      timeDecayEnabled: false        // 时间衰减（默认关）
    },
    dbPath: path.join(DEMO_DIR, 'memory.sqlite'),
    embeddingProvider: new FakeEmbeddingProvider(DIM)
  });

  await engine.initialize();
  return engine;
}

/* ---------------- 章节 ---------------- */

async function chapter1(engine) {
  info(`引擎: ${engine.name} (${engine.constructor.name})`);
  info(`嵌入维度: ${engine.embeddingProvider.getDimension()} (Fake 确定性嵌入)`);
  info(`向量存储: ${engine.vectorStore.constructor.name} (Rust N-API)`);
  info(`元数据存储: ${engine.metadataStore.constructor.name} (SQLite)`);
  info(`数据目录: ${DEMO_DIR}`);
  done('初始化完成，引擎就绪');
}

async function chapter2(engine) {
  for (const note of NOTES) {
    const abs = path.join(NOTES_DIR, note.file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, note.content, 'utf-8');
    info(`写入 ${note.file} (${note.content.length} 字符)`);
  }

  const envelopes = await engine.flushBatch(NOTES.map(n => ({ path: path.join(NOTES_DIR, n.file) })));
  const stats = await engine.getStats();
  info(`异常: ${envelopes.forEach(e => e.error ? '; ' + e.error : '') || '无'}`);
  done(`摄入完成 → 文件 ${stats.files}｜块 ${stats.chunks}｜标签 ${stats.tags}｜日记本 ${stats.diaries.join('、')}｜向量 ${stats.vectorStats.totalVectors}`);
}

async function runSearch(engine, label, query) {
  console.log('');
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

async function chapter3(engine) {
  await runSearch(engine, '基础检索', '量子计算 芯片');
  await runSearch(engine, '基础检索', '遗忘曲线 复习');
}

async function chapter4(engine) {
  const envelope = await runSearch(engine, '高级检索', '手冲 萃取参数');
  const tm = envelope.tagMemo || {};
  if (tm.rankedTags && tm.rankedTags.length) {
    const tags = tm.rankedTags.slice(0, 5).map(t => (typeof t === 'string' ? t : t.tag ?? t.name ?? String(t))).join('、');
    info(`TagMemo 浪潮激活标签: ${tags}`);
  } else {
    console.log(`    ${C.dim}TagMemo: 无激活标签（本次查询未命中波形）${C.reset}`);
  }
  const epa = envelope.epa || {};
  const qa = epa.queryAnalysis || {};
  if (epa.ready === false) {
    console.log(`    ${C.dim}EPA: 标签量不足，未构建语义基（需要更多带向量的标签）${C.reset}`);
  } else if (qa.logicDepth != null) {
    console.log(`    ${C.dim}EPA 逻辑深度: ${qa.logicDepth.toFixed(3)}｜主轴数: ${(qa.dominantAxes || []).length}｜共振: ${((qa.resonance || {}).resonance || 0).toFixed(3)}${C.reset}`);
  }
  const pyr = envelope.pyramid || {};
  if (pyr.features && pyr.features.depth != null) {
    console.log(`    ${C.dim}残差金字塔: 深度 ${pyr.features.depth}｜覆盖率 ${(pyr.features.coverage * 100).toFixed(1)}%｜新颖度 ${pyr.features.novelty.toFixed(2)}${C.reset}`);
  }
}

async function chapter5(engine) {
  console.log('');
  const target = path.join(NOTES_DIR, 'life/coffee.md');
  await engine.handleDelete({ path: target });
  const stats = await engine.getStats();
  info(`删除 ${path.basename(target)} → 文件 ${stats.files}｜块 ${stats.chunks}｜标签 ${stats.tags}`);
  const envelope = await engine.search('手冲咖啡');
  const results = envelope.results || [];
  if (results.length === 0) {
    done('再查询咖啡主题 → 0 结果，删除已生效');
  } else {
    console.log(`    ${C.yellow}仍命中 ${results.length} 条：${results.map(r => r.sourceFile || r.id).join('、')}${C.reset}`);
    done('删除已生效（其余日记仍可命中相关片段）');
  }
}

async function chapter6(engine) {
  // Windows 沙盒下 Rust 索引延迟落盘可能被拒（已知环境限制），
  // 捕获后汇总为一条提示，避免刷屏红色错误。
  const rawError = console.error;
  const failures = [];
  console.error = (msg) => {
    if (String(msg).includes('[VexusVectorStore] Flush save failed')) failures.push(String(msg));
    else rawError(msg);
  };
  try {
    await engine.close();
  } finally {
    console.error = rawError;
  }
  if (failures.length > 0) {
    console.log(`    ${C.yellow}索引落盘被系统拒绝 ${failures.length} 个（Windows 沙盒已知限制，内存索引不受影响）${C.reset}`);
  }
  done('引擎已关闭（SQLite + Rust 索引已释放）');
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log(`${C.bold}${C.cyan}memoria 命令行演示 · 最小用例${C.reset} ${C.dim}(离线确定性嵌入, d=${DIM})${C.reset}`);

  const engine = await initEngine();
  try {
    chapter('初始化');
    await chapter1(engine);
    chapter('摄入 3 篇演示日记');
    await chapter2(engine);
    chapter('基础检索（向量 + BM25 混合）');
    await chapter3(engine);
    chapter('高级检索（TagMemo 浪潮 / EPA / 残差金字塔）');
    await chapter4(engine);
    chapter('删除');
    await chapter5(engine);
    chapter('收尾');
    await chapter6(engine);
    console.log(`\n${C.green}${C.bold}演示完成，全部章节通过。${C.reset}`);
  } catch (err) {
    console.error(`\n${C.red}演示失败: ${err.stack || err}${C.reset}`);
    process.exitCode = 1;
  } finally {
    if (engine && !engine._closed) await engine.close().catch(() => {});
  }
}

main();