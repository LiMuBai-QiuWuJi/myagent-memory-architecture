#!/usr/bin/env node
// 记忆架构包 · 安装器
// 做什么：把 memory-curator/ 下的脚本拷到 <你的家目录>/.dsh/memory-curator/
// 不做什么：不碰你的记忆库、不建仓、不改 settings.json、不联网
//
// 用法：
//   node install.mjs
//   node install.mjs --dest "D:\\tools\\memory-curator"   # 换安装位置
//   node install.mjs --dry-run                            # 只看会做什么
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'memory-curator');
const argv = process.argv.slice(2);
const dry = argv.includes('--dry-run');
const destArg = (() => {
  const i = argv.indexOf('--dest');
  return i >= 0 ? argv[i + 1] : null;
})();
const DEST = destArg ? resolve(destArg) : join(homedir(), '.dsh', 'memory-curator');
const MEM = join(homedir(), '.dsh', 'memory');

const FILES = [
  'budget.mjs', 'daily.mjs', 'curate.mjs', 'curate-core.mjs',
  'distill-day.mjs', 'search.mjs', 'fixlinks.mjs', 'guardrails.mjs',
  'merge-index-cleanup.mjs',
];

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

console.log(`源目录：${SRC}`);
console.log(`安装到：${DEST}`);
console.log(dry ? '模式：dry-run（不改盘）\n' : '');

if (!existsSync(SRC)) {
  console.error('找不到 memory-curator/ —— 请在解压出来的包根目录运行本脚本。');
  process.exit(1);
}
if (!dry) mkdirSync(DEST, { recursive: true });

let copied = 0;
let backed = 0;
for (const f of FILES) {
  const from = join(SRC, f);
  const to = join(DEST, f);
  if (!existsSync(from)) { console.log(`  跳过 ${f}（包里没有）`); continue; }
  if (existsSync(to)) {
    const same = readFileSync(from).equals(readFileSync(to));
    if (same) { console.log(`  一致 ${f}`); continue; }
    const bak = `${to}.bak-${stamp()}`;
    if (!dry) copyFileSync(to, bak);
    console.log(`  覆盖 ${f}（旧版备份为 ${bak.split(/[\\/]/).pop()}）`);
    backed += 1;
  } else {
    console.log(`  新增 ${f}`);
  }
  if (!dry) copyFileSync(from, to);
  copied += 1;
}

// 配置文件只在缺失时生成，绝不覆盖已有配置
const cfg = join(DEST, 'config.json');
if (!existsSync(cfg)) {
  const src = join(SRC, 'config.example.json');
  if (existsSync(src)) {
    if (!dry) writeFileSync(cfg, readFileSync(src));
    console.log('  新增 config.json（从 config.example.json）');
  }
} else {
  console.log('  config.json 已存在，保持原样');
}

console.log(`\n完成：写入 ${copied} 个脚本，其中覆盖 ${backed} 个。`);

// —— 下一步提示（按真实状态说，不猜）——
console.log('\n下一步：');
const libs = [];
try {
  for (const d of readdirSync(join(MEM, 'projects'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = join(MEM, 'projects', d.name, 'memory');
    if (existsSync(p)) libs.push(p);
  }
} catch { /* 没有 projects 目录 */ }
const withIndex = libs.filter((p) => existsSync(join(p, 'MEMORY.md')));

if (!existsSync(MEM)) {
  console.log(`  1) 记忆根不存在：${MEM}`);
  console.log('     → 先在宿主里打开记忆插件、正常聊两轮，让它抽出第一批记忆文件（本包不负责生成记忆）');
} else if (libs.length === 0) {
  console.log(`  1) 记忆根存在但还没有任何库：${join(MEM, 'projects')}\\*\\memory`);
  console.log('     → 先聊两轮产生第一批记忆；只想先试脚本就跑 示例库/ 里的三条命令');
} else if (withIndex.length === 0) {
  console.log(`  1) 找到 ${libs.length} 个库但没有 MEMORY.md → 直接进第 2 步，budget 会建索引`);
} else {
  console.log(`  1) 找到 ${libs.length} 个库，其中 ${withIndex.length} 个已有索引，直接进第 2 步`);
  for (const p of withIndex) console.log(`     · ${p}`);
}
console.log(`  2) node "${join(DEST, 'budget.mjs')}"         # 索引变三段式`);
console.log(`  3) node "${join(DEST, 'search.mjs')}" "随便问一句"   # 验证检索`);
console.log(`  4) node "${join(DEST, 'daily.mjs')}"          # 全套维护（含备份）`);

const st = existsSync(MEM) && statSync(MEM).isDirectory();
console.log(`\n记忆根：${MEM}${st ? '（存在）' : '（还不存在，等宿主先写）'}`);
console.log('向量配置写在 记忆根/settings.json 的 embedding 段；没有 Key 就设 enabled=false，检索只用索引。');
