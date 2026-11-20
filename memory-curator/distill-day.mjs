#!/usr/bin/env node
// 跨天提炼器（2026-11-19 分层方案第 2 层）
//
// 干什么：
//   读库里「今天内容」之外的所有记忆文件（日期 < 今天），用本地规则给出处置计划：
//     merge  —— 同主题簇的多份，正文并进簇里最早的那份（就地改写，不新增第二份）
//     archive—— 流水类（share-round / text-only-round / day- 开头），只留档
//     keep   —— 其余不动
//   执行时：源文件正文先追加到 _daily/<该文件日期>.md 留档，再删源文件。
//   全部删除之前先落 distill-report-<库名>.json。
//
// 本地规则（不调用任何网络模型）：
//   b. 文件名含 share-round / text-only-round，或以 day- 开头 → archive（不 merge）
//   a. 同一天同前缀（去掉文件名里的日期/时间后缀后完全相同），或 description 的
//      token 集合 Jaccard ≥ 0.6 且 type 相同 → 并到簇里最早的那个
//   c. 其余 → keep
//   保护：type: feedback 且被别处 [[链接]] 引用 > 5 次的文件永不删除（可 keep）
//
// 用法：
//   node distill-day.mjs --store <库目录>
//   node distill-day.mjs --all
//   node distill-day.mjs --all --dry      # 只打印计划，不写不删
//
// 幂等：源文件删掉后第二次跑就没有待办，merged/deleted 全 0。

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = homedir();
const CUR = join(HOME, '.dsh', 'memory-curator');
const MEMORY_ROOT = process.env.CURATOR_ROOT || join(HOME, '.dsh', 'memory');
const DRY = process.argv.includes('--dry');
const ALL = process.argv.includes('--all');

const META_FILES = new Set(['MEMORY.md', '_摘要.md', '_索引归档.md']);
const FLOW_RE = /(^|[-_])(share-round|text-only-round)([-_]|$)/;
const DAY_RE = /^day-\d{4}-\d{2}-\d{2}/;
const HAS_DATE_RE = /\d{4}-\d{2}-\d{2}/;
const JACCARD_MIN = 0.6;
const FEEDBACK_LINK_LIMIT = 5;

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const today = () => stamp().slice(0, 10);
const log = (line) => {
  const text = `【${stamp()}】${line}`;
  console.log(text);
  if (!DRY) {
    try { appendFileSync(join(CUR, 'curator.log'), text + '\n', 'utf8'); } catch { /* ignore */ }
  }
};

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
  } catch { /* fallthrough */ }
  try {
    const d = new Date(statSync(file).mtimeMs);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  } catch { return today(); }
}

function splitFront(text) {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: text };
  const head = text.slice(3, end);
  const meta = {};
  for (const line of head.split('\n')) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(text.indexOf('\n', end + 4) + 1) };
}

function describeOf(abs, text) {
  const { meta, body } = splitFront(text);
  if (meta.description && meta.description.trim()) return meta.description.trim();
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('<!--') || t.startsWith('>')) continue;
    return t.replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/[*`_]/g, '');
  }
  return '';
}

// 去日期/时间后缀，落到「同前缀」比较用的名字
function baseName(name) {
  return name.replace(/\.md$/, '')
    .replace(/\d{4}-\d{2}-\d{2}/g, '')
    .replace(/-?\b\d{3,6}\b/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

// 中文没空格：CJK 走字符 bigram，拉丁走词
function tokenSet(text) {
  const s = text.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, ' ');
  const out = new Set();
  for (const word of s.split(/\s+/).filter(Boolean)) {
    if (/[\p{Script=Han}]/u.test(word)) {
      const chars = [...word];
      if (chars.length === 1) out.add(word);
      for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
    } else if (word.length >= 2) out.add(word);
  }
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function storeLabel(root) {
  const parent = basename(dirname(root));
  return parent === 'projects' || parent === 'memory' ? basename(root) : (parent === '.dsh' ? basename(root) : parent);
}

function ensureDaily(root, date) {
  const dir = join(root, '_daily');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${date}.md`);
  if (!existsSync(file)) {
    writeFileSync(file, `# ${date} 归并留档（memory-curator/distill-day.mjs 自动生成，只追加）\n`, 'utf8');
  }
  return file;
}

function influxCounts(root, names) {
  const counts = new Map();
  const scan = (dir) => {
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (e.name === '_daily' || e.name === 'topics' || e.name === 'archive' || e.name === '.git') continue;
        scan(join(dir, e.name));
        continue;
      }
      if (!e.name.endsWith('.md')) continue;
      let text = '';
      try { text = readFileSync(join(dir, e.name), 'utf8'); } catch { continue; }
      for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) {
        const target = m[1].trim().replace(/\.md$/, '');
        if (names.has(target) && target !== e.name.replace(/\.md$/, '')) counts.set(target, (counts.get(target) || 0) + 1);
      }
    }
  };
  scan(root);
  return counts;
}

function planStore(root) {
  const label = storeLabel(root);
  const now = today();
  let ents = [];
  try { ents = readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')); } catch { return { label, plan: [], skipped: 0 }; }
  const names = new Set(ents.map((e) => e.name.replace(/\.md$/, '')));

  const items = [];
  let skippedToday = 0;
  for (const e of ents) {
    if (META_FILES.has(e.name)) continue;
    const abs = join(root, e.name);
    let text = '';
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    const date = fileDate(abs, text);
    if (date >= now) { skippedToday++; continue; }
    let mtimeMs = 0;
    try { mtimeMs = statSync(abs).mtimeMs; } catch { /* ignore */ }
    const { meta, body } = splitFront(text);
    items.push({
      file: e.name, abs, date, mtimeMs,
      type: meta.type || meta.node_type || 'memory',
      description: describeOf(abs, text),
      body,
      action: 'keep',
      target: null,
      reason: '无同簇、非流水 → 保留',
    });
  }

  // 保护名单：type=feedback 且被引用 > 5
  const influx = influxCounts(root, names);

  // b) 流水类 → archive
  for (const it of items) {
    const stem = it.file.replace(/\.md$/, '');
    // 流水类必须同时带日期后缀，避免误伤 dont-ask-for-things-in-share-round.md 这类规则文件
    if (DAY_RE.test(stem) || (FLOW_RE.test(stem) && HAS_DATE_RE.test(stem))) {
      it.action = 'archive';
      it.reason = '流水类（share-round / text-only-round / day-）→ 只留档不进索引';
    }
  }

  // a) 同前缀 / 同 description 的簇 → merge 到最早那个
  const pool = items.filter((it) => it.action !== 'archive');
  const parent = pool.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };

  const byBase = new Map();
  pool.forEach((it, i) => {
    const b = baseName(it.file);
    if (!b) return;
    if (byBase.has(b)) union(byBase.get(b), i); else byBase.set(b, i);
  });
  const tokens = pool.map((it) => tokenSet(it.description));
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (find(i) === find(j)) continue;
      if (pool[i].type !== pool[j].type) continue;
      if (jaccard(tokens[i], tokens[j]) >= JACCARD_MIN) union(i, j);
    }
  }

  const groups = new Map();
  pool.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it);
  });
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => (a.date === b.date ? (a.mtimeMs - b.mtimeMs) || a.file.localeCompare(b.file) : a.date.localeCompare(b.date)));
    const target = sorted[0];
    for (const it of sorted.slice(1)) {
      it.action = 'merge';
      it.target = target.file;
      it.reason = `同簇（前缀/描述相近）→ 并进 ${target.file}`;
    }
    target.reason = `簇里最早的一份（${members.length} 个成员并进来）`;
  }

  // 保护：feedback 被引用 > 5 → 不许删
  for (const it of items) {
    const stem = it.file.replace(/\.md$/, '');
    const n = influx.get(stem) || 0;
    it.influx = n;
    if (it.type === 'feedback' && n > FEEDBACK_LINK_LIMIT && it.action !== 'keep') {
      it.action = 'keep';
      it.target = null;
      it.reason = `type=feedback 且被 [[链接]] 引用 ${n} 次 > ${FEEDBACK_LINK_LIMIT} → 保留`;
    }
  }

  return { label, plan: items, skippedToday };
}

function executeStore(root, label, plan) {
  // 报告先落盘，再删
  const report = {
    at: stamp(),
    store: root,
    label,
    dry: false,
    stats: { merged: 0, deleted: 0, kept: 0 },
    merged: [],
    deleted: [],
    kept: [],
  };
  for (const it of plan) {
    if (it.action === 'merge') { report.merged.push({ file: it.file, target: it.target, date: it.date, reason: it.reason }); report.stats.merged++; }
    else if (it.action === 'archive') { report.deleted.push({ file: it.file, date: it.date, reason: it.reason }); report.stats.deleted++; }
    else { report.kept.push({ file: it.file, date: it.date, reason: it.reason }); report.stats.kept++; }
  }
  const reportPath = join(CUR, `distill-report-${label.replace(/[^\w.-]/g, '_')}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  const dailyFiles = new Set();
  for (const it of plan) {
    if (it.action === 'keep') continue;
    const body = it.body.trim();
    if (it.action === 'merge') {
      const targetAbs = join(root, it.target);
      const prev = readFileSync(targetAbs, 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '');
      writeFileSync(targetAbs, `${prev}\n\n### 来源：${it.file}（${it.date}）\n\n${body}\n`, 'utf8');
    }
    const daily = ensureDaily(root, it.date);
    dailyFiles.add(basename(daily));
    appendFileSync(daily, `\n### ${it.file}（${it.date}）· ${it.action}${it.action === 'merge' ? ` → ${it.target}` : ''}\n\n${body}\n`, 'utf8');
    try { unlinkSync(it.abs); } catch (err) { log(`删除失败 ${it.file}：${String(err && err.message).slice(0, 120)}`); }
  }
  report.dailyFiles = [...dailyFiles].sort();
  report.doneAt = stamp();
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return { report, reportPath };
}

function resolveTargets() {
  const args = process.argv;
  const out = [];
  const si = args.indexOf('--store');
  if (si >= 0 && args[si + 1]) {
    out.push(join(args[si + 1]));
    return out;
  }
  if (ALL) {
    const g = join(MEMORY_ROOT, 'global');
    if (existsSync(g)) out.push(g);
    const pr = join(MEMORY_ROOT, 'projects');
    if (existsSync(pr)) {
      for (const e of readdirSync(pr, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const root = join(pr, e.name, 'memory');
        if (existsSync(root)) out.push(root);
      }
    }
  }
  return out;
}

const targets = resolveTargets();
if (!targets.length) {
  console.log('用法：node distill-day.mjs --store <库目录>  |  --all  |  加 --dry 只看计划');
  process.exit(1);
}

const summary = [];
for (const root of targets) {
  const { label, plan, skippedToday } = planStore(root);
  if (!plan.length) {
    log(`[${label}] 没有待提炼的文件（今天内 ${skippedToday} 个已跳过）`);
    summary.push({ label, merged: 0, deleted: 0, kept: 0, dailyFiles: [] });
    continue;
  }
  const counts = { merge: 0, archive: 0, keep: 0 };
  for (const it of plan) counts[it.action]++;
  log(`[${label}] 待提炼 ${plan.length} 个（今天跳过 ${skippedToday}）：merge ${counts.merge} / archive ${counts.archive} / keep ${counts.keep}`);
  for (const it of plan) {
    console.log(`  ${it.action.padEnd(7)} ${it.file}${it.target ? ` → ${it.target}` : ''}  · ${it.reason}`);
  }
  if (DRY) {
    summary.push({ label, merged: counts.merge, deleted: counts.archive, kept: counts.keep, dailyFiles: [], dry: true });
    continue;
  }
  const { report, reportPath } = executeStore(root, label, plan);
  log(`[${label}] 已执行：merge ${report.stats.merged} / archive ${report.stats.deleted} / keep ${report.stats.kept}；报告 ${reportPath}`);
  summary.push({ label, merged: report.stats.merged, deleted: report.stats.deleted, kept: report.stats.kept, dailyFiles: report.dailyFiles });
}

if (!DRY) {
  log('重排索引：node budget.mjs');
  try {
    const out = execFileSync(process.execPath, [join(CUR, 'budget.mjs')], { cwd: CUR, stdio: 'pipe', timeout: 300000 }).toString('utf8');
    for (const line of out.trim().split('\n')) console.log(line);
  } catch (err) {
    const msg = String((err && err.stderr ? err.stderr.toString('utf8') : '') + (err && err.message ? err.message : '')).slice(0, 300);
    log(`索引重排失败：${msg}`);
  }
}

console.log('\n===== 汇总 =====');
for (const s of summary) {
  console.log(`${s.label}: merged ${s.merged ?? 0} / deleted ${s.deleted ?? 0} / kept ${s.kept ?? 0}${s.dailyFiles && s.dailyFiles.length ? ` · _daily: ${s.dailyFiles.join(', ')}` : ''}${s.dry ? '  (dry)' : ''}`);
}
