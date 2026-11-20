#!/usr/bin/env node
// 修死链：[[name]] 指向不存在的 <name>.md 时，按「同目录唯一近似」改写；拿不准的只报告不改
// 用法：node fixlinks.mjs [--apply]   （默认 dry-run）
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

// 自动发现全部记忆库：~/.dsh/memory/projects/*/memory，不写死任何库 id
const MEM = join(homedir(), '.dsh', 'memory');
const STORES = (() => {
  const out = [];
  const projRoot = join(MEM, 'projects');
  try {
    for (const d of readdirSync(projRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = join(projRoot, d.name, 'memory');
      if (existsSync(p)) out.push(p);
    }
  } catch { /* 没有 projects 目录就只扫 global */ }
  const g = join(MEM, 'global');
  if (existsSync(g)) out.push(g);
  return out;
})();
const APPLY = process.argv.includes('--apply');
const report = [];
let fixed = 0;
let left = 0;

for (const dir of STORES) {
  if (!existsSync(dir)) continue;
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  const set = new Set(files.map((f) => f.toLowerCase()));
  for (const f of files) {
    const p = join(dir, f);
    let text = readFileSync(p, 'utf8');
    let changed = false;
    text = text.replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, (all, rawName, alias) => {
      const name = String(rawName).trim();
      const key = name.toLowerCase().endsWith('.md') ? name.toLowerCase() : `${name.toLowerCase()}.md`;
      if (key.startsWith('global:')) return all; // 另一套命名空间，不碰
      if (set.has(key)) return all;
      // 近似：同名不同日期后缀 / 同名带 -2026-xx-xx / 去掉后缀后唯一命中
      const stem = key.replace(/\.md$/, '');
      const cands = files.filter((c) => {
        const s = c.toLowerCase().replace(/\.md$/, '');
        return s === stem || s.startsWith(stem + '-') || stem.startsWith(s + '-');
      });
      if (cands.length === 1) {
        fixed += 1;
        report.push(`FIX  ${f}  [[${name}]] → ${cands[0]}`);
        changed = true;
        return `[[${alias ? cands[0].replace(/\.md$/i, '') + alias : cands[0].replace(/\.md$/i, '')}]]`;
      }
      left += 1;
      report.push(`LEFT ${f}  [[${name}]]  候选 ${cands.length}`);
      return all;
    });
    if (changed && APPLY) writeFileSync(p, text, 'utf8');
  }
}

console.log(`${APPLY ? '已应用' : '预演'}：可修 ${fixed} 处，需人工 ${left} 处`);
for (const r of report) console.log(r);
