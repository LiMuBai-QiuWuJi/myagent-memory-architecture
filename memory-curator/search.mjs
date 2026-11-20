#!/usr/bin/env node
// 记忆检索：先查索引，查不到/不满意走向量库
//
// 用法：
//   node search.mjs "关于我的人物卡 技术栈"
//   node search.mjs "人物卡" --vector      # 强制走向量
//   node search.mjs "人物卡" --json        # 给工具调用方用
//   node search.mjs "人物卡" --scope <库名片段>|global|all
//
// 两级：
//   一级 = 索引文本匹配（MEMORY.md + _摘要.md + _索引归档.md，命中即返回文件路径）
//   二级 = 向量（bge-m3，读 ~/.dsh/memory/embeddings.json 现成向量，0 命中的文件不回算）
//
// 索引级命中不等于内容正确：它只说明标题/hook 沾词，要不要读原文由调用方决定。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const ROOT = process.env.CURATOR_ROOT || join(homedir(), '.dsh', 'memory');
const SETTINGS = join(homedir(), '.dsh', 'memory', 'settings.json');

const argv = process.argv.slice(2);
const jsonMode = argv.includes('--json');
const forceVector = argv.includes('--vector');
const scopeArg = (() => {
  const i = argv.indexOf('--scope');
  return i >= 0 ? argv[i + 1] : 'all';
})();
const query = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--scope').join(' ').trim();

if (query === '') {
  console.error('用法：node search.mjs "查询内容" [--vector] [--json] [--scope <库名片段>|global|all]');
  process.exit(2);
}

const stores = [];
if (existsSync(join(ROOT, 'global'))) stores.push({ label: 'global', dir: join(ROOT, 'global'), key: 'global' });
const projRoot = join(ROOT, 'projects');
if (existsSync(projRoot)) {
  for (const e of readdirSync(projRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = join(projRoot, e.name, 'memory');
    if (existsSync(dir)) stores.push({ label: e.name, dir, key: `project:${e.name}` });
  }
}
const picked = stores.filter((s) => {
  if (scopeArg === 'all') return true;
  if (scopeArg === 'global') return s.label === 'global';
  return s.label.includes(scopeArg);
});

// —— 一级：索引文本匹配 ——
function tokensOf(text) {
  const out = new Set();
  for (const w of text.toLowerCase().split(/[\s,，。;；、/|]+/)) if (w.length >= 2) out.add(w);
  const cjk = text.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i + 2 <= cjk.length; i += 1) out.add(cjk.slice(i, i + 2));
  return [...out];
}

function scanIndex(store) {
  const files = ['MEMORY.md', '_摘要.md', '_索引归档.md', 'archive/ARCHIVE.md'];
  const tokens = tokensOf(query);
  const hits = [];
  for (const f of files) {
    const p = join(store.dir, f);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf8').split(/\r?\n/);
    lines.forEach((line, idx) => {
      const t = line.trim();
      if (t === '' || t.startsWith('<!--') || t.startsWith('#')) return;
      const low = t.toLowerCase();
      let score = 0;
      for (const tok of tokens) if (low.includes(tok)) score += tok.length >= 3 ? 2 : 1;
      if (score === 0) return;
      const rel = (line.match(/\]\(([^)]+\.md)\)/) || [])[1] || '';
      hits.push({ store: store.label, file: rel, path: rel ? join(store.dir, rel) : p, line: t, score, from: f, lineNo: idx + 1 });
    });
  }
  return hits;
}

let hits = [];
if (!forceVector) {
  for (const s of picked) hits.push(...scanIndex(s));
  hits.sort((a, b) => b.score - a.score);
  hits = hits.slice(0, 10);
}

// project:<相对路径> 的向量键不带项目 id（只对当前工作区项目建过向量），按文件存在性反查
function resolveProjectFile(rel) {
  for (const s of stores) {
    if (s.label === 'global') continue;
    const p = join(s.dir, rel);
    if (existsSync(p)) return p;
  }
  return '';
}

// —— 二级：向量兜底 ——
async function vectorSearch() {
  const emb = join(ROOT, 'embeddings.json');
  if (!existsSync(emb)) return { error: '没有 embeddings.json' };
  const store = JSON.parse(readFileSync(emb, 'utf8'));
  const items = store.items || {};
  const settings = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {};
  const cfg = settings.embedding || {};
  if (!cfg.apiKey || !cfg.baseUrl) return { error: '没配 embedding.apiKey' };
  const resp = await fetch(cfg.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model || 'BAAI/bge-m3', input: [query], encoding_format: 'float' }),
  });
  if (!resp.ok) return { error: `嵌入接口 ${resp.status}` };
  const data = await resp.json();
  const qv = data?.data?.[0]?.embedding;
  if (!Array.isArray(qv)) return { error: '嵌入返回格式异常' };
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]; return s; };
  const out = [];
  for (const [key, val] of Object.entries(items)) {
    const vec = Array.isArray(val) ? val : val?.vec || val?.vector;
    if (!Array.isArray(vec)) continue;
    out.push({ key, score: dot(qv, vec) / (Math.hypot(...qv) * Math.hypot(...vec) || 1) });
  }
  out.sort((a, b) => b.score - a.score);
  const topK = cfg.topK || 5;
  const minScore = cfg.minScore || 0.35;
  return {
    model: cfg.model || 'BAAI/bge-m3',
    total: out.length,
    results: out.slice(0, topK).filter((r) => r.score >= minScore).map((r) => {
      const cut = r.key.indexOf(':');
      const prefix = cut > 0 ? r.key.slice(0, cut) : 'project';
      const rest = cut > 0 ? r.key.slice(cut + 1) : r.key;
      const path = prefix === 'global' ? join(ROOT, 'global', rest) : resolveProjectFile(rest);
      return { key: r.key, score: Number(r.score.toFixed(4)), exists: Boolean(path) && existsSync(path), path: path || '' };
    }),
  };
}

(async () => {
  let vec = null;
  // 索引命中太弱（最高分 < 3，多半只撞了个二字词）也算「不满意」，照样补一次向量
  const strongEnough = hits.length > 0 && hits[0].score >= 3;
  if (forceVector || !strongEnough) {
    try { vec = await vectorSearch(); } catch (e) { vec = { error: String(e && e.message ? e.message : e) }; }
  }
  if (jsonMode) {
    console.log(JSON.stringify({ query, indexHits: hits, vector: vec }, null, 2));
    return;
  }
  if (hits.length) {
    console.log(`索引命中 ${hits.length} 条：`);
    for (const h of hits) console.log(`  [${h.score}] ${h.store}/${h.from}:${h.lineNo}  ${h.line.slice(0, 130)}`);
  } else {
    console.log('索引 0 命中');
  }
  if (vec) {
    console.log('提示：只 Read 命中那一篇，别顺着它的 [[链接]] 递归读；要跳第二层先说清为什么。');
    if (vec.error) console.log(`向量兜底没走成：${vec.error}（以下只有索引结果，仍可用）`);
    else {
      console.log(`向量兜底（${vec.model}，${vec.total} 条向量）：`);
      for (const r of vec.results) console.log(`  [${r.score}] ${r.key}${r.exists ? `\n      路径 ${r.path}` : '（文件不存在）'}`);
      if (!vec.results.length) console.log('  无过线结果（minScore 门槛内为空）');
    }
  }
})();
