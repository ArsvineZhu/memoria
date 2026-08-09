'use strict';

/**
 * demo-recall.js — 记忆召回演示（真实 DashScope 嵌入）
 *
 * 流程：
 *   1. 读取 .env 的 EMBED_API_KEY（缺失则直接退出）
 *   2. 用 qwen3.7-text-embedding (1024 维) 真实嵌入 tests/fixtures/real-docs 的 10 篇文档
 *   3. 依次执行 6 个难度递增的语义查询（直配 / 同义改写 / 跨主题联想 / 概念等价）
 *   4. 打印每个查询的召回排序（top3：分数、来源文件、内容摘要、标签）
 *
 * 运行：node demo-recall.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMemoryEngine } = require('../..');
const KnowledgeBaseAdapter = require('../../src/compat/knowledge-base-adapter');
const DashScopeEmbeddingProvider =
  require('../../src/providers/dashscope-embedding-provider');

// ── 配置 ─────────────────────────────────────────────────────────────
const DIM = 1024;

function loadApiKey() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return null;
  const line = fs.readFileSync(envPath, 'utf-8')
    .split(/\r?\n/)
    .find(l => /^EMBED_API_KEY\s*=/.test(l.trim()));
  if (!line) return null;
  return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
}

const QUERIES = [
  { tag: '直配', query: '量子纠缠 叠加态 退相干', hint: '→ 量子计算文档' },
  { tag: '同义改写', query: '晚上总是睡不着，有什么助眠的办法', hint: '→ 中医养生（“泡脚按揉涌泉穴”原文）' },
  { tag: '同义改写', query: '想减肥又不想去健身房，怎么安排运动', hint: '→ 健身计划（“低冲击运动保护膝盖”）' },
  { tag: '跨主题联想', query: '办公室工位上放点什么绿植好养活', hint: '→ 办公室植物' },
  { tag: '概念等价', query: '长期定投指数基金能赚钱吗', hint: '→ 股票投资（“定投宽基指数基金”）' },
  { tag: '模糊记忆', query: '上次记的猫粮挑选要点是什么来着', hint: '→ 猫咪养护' }
];

// ── 主流程 ───────────────────────────────────────────────────────────
async function main() {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error('✖ 未找到 EMBED_API_KEY（请确认 demo 根目录 .env 已配置）');
    process.exit(1);
  }
  console.log(`◈ memoria 记忆召回演示 · qwen3.7-text-embedding · ${DIM} 维`);
  console.log(`◈ 模型真实调用，共 6 组查询\n`);

  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-root'));
  const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-store'));

  const engine = createMemoryEngine({
    config: {
      dimension: DIM,
      rootPath,
      storePath,
      chunkMaxTokens: 600,
      chunkOverlapTokens: 96,
      indexSaveDelay: 120000,
      tagIndexSaveDelay: 300000,
      persistTagIndex: false,
      expansionEnabled: false,
      timeDecayEnabled: false
    },
    dbPath: path.join(storePath, 'memory.sqlite'),
    embeddingProvider: new DashScopeEmbeddingProvider({
      apiKey,
      model: 'qwen3.7-text-embedding',
      dimension: DIM
    })
  });
  const kb = new KnowledgeBaseAdapter({ engine });

  try {
    await kb.initialize();

    // 1. 灌库：fixtures 全部复制到 rootPath/diaryX 下，保证日记名解析
    const docs = [];
    for (const name of fs.readdirSync(path.join(__dirname, '../../tests/fixtures/real-docs'))
      .filter(n => n.endsWith('.md'))
      .sort()) {
      const rel = path.join('diaryX', name);
      const target = path.join(rootPath, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '../../tests/fixtures/real-docs', name), target);
      docs.push({ path: target });
    }
    console.log(`◈ 灌库中：${docs.length} 篇中文文档 × 真实嵌入...`);
    await kb.flushBatch(docs);
    const stats = await kb.getStats();
    console.log(`◈ 已入库 ${stats.files} 个文件 / ${stats.chunks} 个 chunk / ${stats.vectorStats.totalVectors} 个向量\n`);

    // 2. 逐组查询召回
    for (const { tag, query, hint } of QUERIES) {
      console.log(`┌─ [${tag}] “${query}”`);
      console.log(`│  ${hint}`);
      const out = await kb.search(query);
      const top = (out.results || []).slice(0, 3);
      if (top.length === 0) {
        console.log('│  （无结果）\n');
        continue;
      }
      const rank = ['①', '②', '③'];
      top.forEach((r, i) => {
        const source = String(r.path || r.fullPath || '?').split(/[\\/]/).pop();
        const text = String(r.content || r.text || '').replace(/\s+/g, ' ').slice(0, 46);
        const tags = Array.isArray(r.tags) && r.tags.length
          ? r.tags.map(t => `#${t}`).join(' ')
          : '';
        console.log(`│  ${rank[i]} ${Number(r.score).toFixed(4)}  ${source}`);
        console.log(`│     ${text}${text.length >= 46 ? '…' : ''}`);
        if (tags) console.log(`│     ${tags}`);
      });
      console.log(`└───────────────────────────────────────────────\n`);
    }

    console.log('◈ 演示完成。');
  } finally {
    try { await kb.shutdown(); } catch (_) {}
    try { fs.rmSync(rootPath, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(storePath, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch(e => {
  console.error('✖ 演示失败：', e);
  process.exit(1);
});