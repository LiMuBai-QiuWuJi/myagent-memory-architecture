#!/usr/bin/env node
// keepsake 索引预算器 v3（2026-11-19 分层版：摘要区 / 今天内容 / 记忆索引）
//
// 设计规则：
//   1) 索引分三段，固定顺序：
//        摘要区（_摘要.md，48 行封顶）
//        ## 今天内容（未提炼）—— 当天新增的记忆文件，一条一行，最多 40 行，独立额度
//        ## 记忆索引       —— 走评分/预算的常驻条目
//   2) 「今天内容」里的文件不参与评分预算，不会被挤到 _索引归档.md
//   3) 被挤出的索引行不删档：行本身进 _索引归档.md，原文留在原处
//   4) 摘要与归档都带文件指针，需要细节时按路径读原文或走向量检索
//   5) 跨天提炼由 distill-day.mjs 做：它读「今天内容」之外的旧文件，merge/archive/keep
//
// 用法：
//   node budget.mjs              # 实跑：重排 MEMORY.md + 生成 distill-pending.json
//   node budget.mjs --dry-run    # 只报账
//   node budget.mjs --check      # 只打印各库行数/字符数是否超预算
//
// 预算（与 keepsake 默认一致，改这里等于改注入上限）：
//   总行数 200 / 总字符 24000 / 摘要区 48 行 / 今天内容 40 行（独立额度）

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const MEMORY_ROOT = process.env.CURATOR_ROOT || join(homedir(), '.dsh', 'memory');
const LOG_PATH = join(homedir(), '.dsh', 'memory-curator', 'curator.log');
const DRY = process.argv.includes('--dry-run');
const CHECK = process.argv.includes('--check');

const MAX_LINES = 200;
const MAX_CHARS = 24000;
const SUMMARY_MAX_LINES = 48;
const TODAY_MAX_LINES = 40;
const HALF_LIFE = 30;
const DEFAULT_IMPORTANCE = 3;

// 固定骨架行数（GENERATED 头 / 空行 / 摘要区两行标记 / 两个小标题 / 空行 / 指针行 / 末尾空）
const FIXED_OVERHEAD = 11;

const TODAY_HEADING = '## 今天内容（未提炼）';
const INDEX_HEADING = '## 记忆索引';

const SUM_BEGIN = '<!-- 摘要区:begin · 由 memory-curator/_摘要.md 生成，勿手改 -->';
const SUM_END = '<!-- 摘要区:end -->';

// 库根目录里不属于「记忆条目」的文件
const META_FILES = new Set(['MEMORY.md', '_摘要.md', '_索引归档.md', '_daily.md']);

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const log = (line) => {
  const text = `【${stamp()}】${line}`;
  console.log(text);
  if (!DRY && !CHECK) {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, text + '\n', 'utf8');
  }
};

// 文件自身的「日期」：文件名里的 YYYY-MM-DD 优先（git/合并脚本会把 mtime 全刷成今天），
// 其次 frontmatter 的 date/created，最后才是 mtime 的本地日期。
function fileDate(file, text) {
  const base = file.replace(/\\/g, '/').split('/').pop();
  const m = /(\d{4}-\d{2}-\d{2})/.exec(base);
  if (m) return m[1];
  try {
    const t = text === undefined ? readFileSync(file, 'utf8') : text;
    if (t.startsWith('---')) {
      const end = t.indexOf('\n---', 3);
      const head = end > 0 ? t.slice(0, end) : '';
      const dm = /^date:\s*["']?(\d{4}-\d{2}-\d{2})/m.exec(head) || /^created:\s*["']?(\d{4}-\d{2}-\d{2})/m.exec(head);
      if (dm) return dm[1];
    }
  } catch { /* 读不到就用 mtime */ }
  try {
    const d = new Date(statSync(file).mtimeMs);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  } catch { return today(); }
}

function frontMeta(file) {
  try {
    const text = readFileSync(file, 'utf8');
    if (!text.startsWith('---')) return {};
    const end = text.indexOf('\n---', 3);
    if (end < 0) return {};
    const meta = {};
    for (const line of text.slice(3, end).split('\n')) {
      const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
      if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return meta;
  } catch { return {}; }
}

// 一段话：frontmatter description 优先，其次正文第一行非标题文字
function describeOf(file) {
  const meta = frontMeta(file);
  if (meta.description && meta.description.trim()) return meta.description.trim();
  try {
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    let body = text;
    if (text.startsWith('---')) {
      const end = text.indexOf('\n---', 3);
      if (end > 0) body = text.slice(text.indexOf('\n', end + 4) + 1);
    }
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('<!--') || t.startsWith('>')) continue;
      return t.replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/[*`_]/g, '');
    }
  } catch { /* ignore */ }
  return '';
}

function scoreOf(file) {
  let ageDays = 30;
  let importance = DEFAULT_IMPORTANCE;
  try {
    ageDays = (Date.now() - statSync(file).mtimeMs) / 86400000;
    const meta = frontMeta(file);
    const n = Number(meta.importance);
    if (Number.isFinite(n) && n >= 1 && n <= 5) importance = n;
  } catch { /* 文件缺失按最老算 */ }
  const decay = Math.pow(0.5, ageDays / HALF_LIFE);
  const boost = ageDays <= 7 ? 0.8 : 0;
  return { score: importance * decay + boost, importance, ageDays };
}

function readSummary(root) {
  const p = join(root, '_摘要.md');
  if (!existsSync(p)) return { lines: [], exists: false };
  const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  return { lines, exists: true };
}

// 当天新增的记忆文件（按日期判定，mtime 倒序取前 40）
function todayEntries(root) {
  const out = [];
  let names = [];
  try { names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name); } catch { return out; }
  const now = today();
  for (const name of names) {
    if (META_FILES.has(name)) continue;
    const abs = join(root, name);
    if (fileDate(abs) !== now) continue;
    let mtimeMs = 0;
    try { mtimeMs = statSync(abs).mtimeMs; } catch { continue; }
    out.push({ name, mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, TODAY_MAX_LINES).map(({ name }) => {
    const desc = describeOf(join(root, name)).slice(0, 60);
    return desc ? `- [${name.replace(/\.md$/, '')}](${name}) — ${desc}` : `- [${name.replace(/\.md$/, '')}](${name})`;
  });
}

function processStore(root, label) {
  const idx = join(root, 'MEMORY.md');
  if (!existsSync(idx)) return null;
  const raw = readFileSync(idx, 'utf8').replace(/\r\n/g, '\n');
  const allLines = raw.split('\n');

  // 拆段：摘要块 / 今天内容 / 记忆索引 / 头部
  const links = [];
  const others = [];
  let inSum = false;
  let section = 'header';
  for (const line of allLines) {
    const t = line.trim();
    if (t.startsWith('<!-- 摘要区:begin')) { inSum = true; continue; }
    if (t.startsWith('<!-- 摘要区:end')) { inSum = false; continue; }
    if (inSum) continue;
    if (t.startsWith('<!--')) continue;
    if (t === TODAY_HEADING || t.startsWith('## 今天内容')) { section = 'today'; continue; }
    if (t === INDEX_HEADING || /^##\s*记忆索引/.test(t)) { section = 'index'; continue; }
    if (t === '') continue;
    if (/^-\s*\[/.test(t)) {
      if (/更早的记忆|归档索引/.test(t)) continue; // 归档指针每次重建，不进索引池
      if (section === 'today') continue; // 今天内容每次从磁盘重建
      links.push(t);
      continue;
    }
    if (section === 'today') continue;
    others.push(t); // 标题、说明、归档指针等
  }

  // 逐条打分（按链接目标路径）
  const scored = links.map((line, i) => {
    const m = /\]\(([^)]+\.md)\)/.exec(line);
    const rel = m ? m[1] : '';
    const abs = rel && !rel.includes('://') ? join(root, rel) : '';
    const s = abs ? scoreOf(abs) : { score: 0, importance: 0, ageDays: 999 };
    return { line, rel, i, ...s, exists: abs ? existsSync(abs) : false };
  }).filter((e) => e.exists); // 悬空行直接丢掉（会在日志里报数）

  const dangling = links.length - scored.length;
  const sum = readSummary(root);
  const sumLines = sum.lines.slice(0, SUMMARY_MAX_LINES);
  const todayLines = todayEntries(root);

  // 头部行（其它非链接行，去掉旧的归档指针，稍后重建）
  const head = others.filter((l) => !/更早的记忆|归档索引/.test(l));

  // 行数 + 字符双预算：今天内容是独立额度，只从正文预算里扣
  const lineRoom = MAX_LINES - sumLines.length - todayLines.length - head.length - FIXED_OVERHEAD;
  const charRoom = MAX_CHARS - sumLines.join('').length - todayLines.join('').length - head.join('').length - 1200;
  const keptIdx = new Set();
  let usedLines = 0;
  let usedChars = 0;
  for (const e of [...scored].sort((a, b) => b.score - a.score)) {
    const nextLines = usedLines + 1;
    const nextChars = usedChars + e.line.length + 1;
    if (nextLines > lineRoom || nextChars > charRoom || nextLines > MAX_LINES) break;
    keptIdx.add(e.i);
    usedLines = nextLines;
    usedChars = nextChars;
  }
  const kept = scored.filter((e) => keptIdx.has(e.i));      // 保原顺序
  const overflow = scored.filter((e) => !keptIdx.has(e.i));

  if (CHECK) {
    return { label, root, links: links.length, dangling, kept: kept.length, overflow: overflow.length, today: todayLines.length, sumLines: sumLines.length, chars: raw.length, lines: allLines.length };
  }

  // 溢出 → _索引归档.md
  const archPath = join(root, '_索引归档.md');
  if (overflow.length && !DRY) {
    if (!existsSync(archPath)) {
      writeFileSync(archPath, '# 索引归档（预算挤出，不是删除）\n\n原文都在本目录，按链接里的文件名直接 Read。先看 _摘要.md 找主题。\n\n', 'utf8');
    }
    const month = stamp().slice(0, 7);
    const prev = readFileSync(archPath, 'utf8');
    const have = new Set(prev.split('\n').map((l) => l.trim()));
    const fresh = overflow.map((e) => e.line).filter((l) => !have.has(l.trim()));
    const block = fresh.join('\n');
    const marker = `## ${month} 挤出`;
    if (fresh.length > 0) {
      writeFileSync(archPath, prev.includes(marker) ? `${prev}\n${block}\n` : `${prev}\n${marker}\n\n${block}\n`, 'utf8');
    }
  }

  // 溢出 → 蒸馏清单（给 04:00 的 AI 整理会话读）
  if (overflow.length && !DRY) {
    const pending = overflow.map((e) => ({ file: e.rel, title: (e.line.match(/^- \[([^\]]+)\]/) || [])[1] || e.rel, hook: e.line.split('—').slice(1).join('—').trim(), importance: e.importance, ageDays: Math.round(e.ageDays), score: Number(e.score.toFixed(2)) }));
    writeFileSync(join(root, 'distill-pending.json'), JSON.stringify({ at: stamp(), total: pending.length, entries: pending }, null, 2) + '\n', 'utf8');
  } else if (!DRY && existsSync(join(root, 'distill-pending.json'))) {
    writeFileSync(join(root, 'distill-pending.json'), JSON.stringify({ at: stamp(), total: 0, entries: [] }, null, 2) + '\n', 'utf8');
  }

  // 重建 MEMORY.md：三段固定顺序
  const out = [
    `<!-- GENERATED by memory-curator/budget.mjs · ${stamp()} · 摘要区来自 _摘要.md，索引行来自 keepsake 提取 · 勿手改 -->`,
    ...head,
    '',
    SUM_BEGIN,
    ...sumLines,
    ...(sum.exists ? [] : ['- （空：等 04:00 的整理会话把被挤出的旧条目蒸馏进来）']),
    SUM_END,
    '',
    TODAY_HEADING,
    ...(todayLines.length ? todayLines : ['- （今天还没有新记忆）']),
    '',
    INDEX_HEADING,
    ...kept.map((e) => e.line),
    '',
    `- [更早的记忆（索引归档，按需 Read）](_索引归档.md) — ${overflow.length} 条本轮挤出，累计见本文件；要细节先看 _摘要.md`,
    '',
  ].join('\n');

  if (!DRY && out !== raw) writeFileSync(idx, out, 'utf8');
  const chars = out.length;
  const lines = out.split('\n').length;
  return { label, root, links: links.length, dangling, kept: kept.length, overflow: overflow.length, today: todayLines.length, sumLines: sumLines.length, chars, lines, over: chars > MAX_CHARS || lines > MAX_LINES };
}

const targets = [];
const g = join(MEMORY_ROOT, 'global');
if (existsSync(g)) targets.push([g, 'global']);
const pr = join(MEMORY_ROOT, 'projects');
if (existsSync(pr)) {
  for (const e of readdirSync(pr, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const root = join(pr, e.name, 'memory');
    if (existsSync(root)) targets.push([root, `project:${e.name}`]);
  }
}

const results = [];
for (const [root, label] of targets) {
  const r = processStore(root, label);
  if (r) results.push(r);
}

if (CHECK) {
  for (const r of results) console.log(`${r.label}: ${r.lines} 行 / ${r.chars} 字符 · 索引 ${r.links}（悬空 ${r.dangling}）· 摘要 ${r.sumLines} 行 · 今天 ${r.today} 行`);
  process.exit(0);
}

for (const r of results) {
  log(`${r.label}：索引 ${r.links} 条（悬空丢了 ${r.dangling}），留 ${r.kept}，挤出 ${r.overflow}，摘要 ${r.sumLines} 行，今天 ${r.today} 行 → ${r.lines} 行 / ${r.chars} 字符${r.over ? '  ⚠ 仍超预算' : ''}`);
}
log(`预算：${MAX_LINES} 行 / ${MAX_CHARS} 字符；摘要区上限 ${SUMMARY_MAX_LINES} 行；今天内容上限 ${TODAY_MAX_LINES} 行（独立额度）`);

{ processStore };
