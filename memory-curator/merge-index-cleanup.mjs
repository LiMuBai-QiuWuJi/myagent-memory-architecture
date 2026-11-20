#!/usr/bin/env node
// 合并后的索引收尾：删掉指向已删文件的索引行，补上新 merged 文件的索引行
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// 自动发现全部记忆库：~/.dsh/memory/projects/*/memory（不写死库 id）
const MEM = join(homedir(), '.dsh', 'memory');
const STORES = (() => {
  const out = [];
  try {
    for (const d of readdirSync(join(MEM, 'projects'), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = join(MEM, 'projects', d.name, 'memory');
      if (existsSync(p)) out.push(p.replace(/\\/g, '/'));
    }
  } catch { /* 没有 projects 目录 */ }
  return out;
})();

function fm(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^(\w+):\s*"?(.*?)"?\s*$/);
    if (mm) out[mm[1]] = mm[2];
  }
  return out;
}

for (const dir of STORES) {
  if (!existsSync(dir)) continue;
  const idxPath = join(dir, 'MEMORY.md');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md' && !f.startsWith('_'));
  const set = new Set(files);
  let idx = readFileSync(idxPath, 'utf8');
  const lines = idx.split('\n');
  const kept = [];
  let dropped = 0;
  const linked = new Set();
  for (const line of lines) {
    const m = line.match(/\]\(([^)]+\.md)\)/);
    if (m) {
      const t = m[1];
      if (!set.has(t)) { dropped++; continue; }
      linked.add(t);
    }
    kept.push(line);
  }
  // 补新文件（merged 或新增未入索引）
  // 补新文件（merged 或新增未入索引）；已在 _索引归档.md 里的不再补，避免把归档条目倒回索引
  const archPath = join(dir, '_索引归档.md');
  const arch = existsSync(archPath) ? readFileSync(archPath, 'utf8') : '';
  const archSet = new Set();
  for (const m of arch.matchAll(/\]\(([^)]+\.md)\)/g)) archSet.add(m[1]);
  const added = [];
  for (const f of files) {
    if (linked.has(f) || archSet.has(f)) continue;
    const f2 = fm(readFileSync(join(dir, f), 'utf8'));
    const title = (f2.name || f.replace(/\.md$/, '')).replace(/^day-/, '').replace(/-log$/, ' 日志');
    const desc = (f2.description || '').slice(0, 140).replace(/\n/g, ' ');
    added.push(`- [${title}](${f}) — ${desc}`);
  }
  // 插在最后一条链接行之后
  let lastLink = -1;
  for (let i = 0; i < kept.length; i++) if (/\]\([^)]+\.md\)/.test(kept[i])) lastLink = i;
  if (added.length) kept.splice(lastLink + 1, 0, ...added);
  writeFileSync(idxPath, kept.join('\n'), 'utf8');
  console.log(`${dir.split('\\').pop().slice(0, 20)}：删索引行 ${dropped}，补 ${added.length}，现文件 ${files.length}`);
}
