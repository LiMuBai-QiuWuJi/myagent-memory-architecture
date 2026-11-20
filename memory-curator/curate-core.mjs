#!/usr/bin/env node
// keepsake 记忆整理器（遗忘曲线 + 冷热分层）
// 用法：
//   node curate.mjs            # 实际执行
//   node curate.mjs --dry-run  # 只打印计划，不动文件
// 规则：
//   - 每条记忆按「重要度 × 0.5^(年龄/半衰期)」打分，越老分越低
//   - 每个作用域只把分数最高的 N 条留在热区（MEMORY.md 索引里可见、可被召回）
//   - 其余移入 archive/<YYYY-MM>/<分类>/，并在 archive/ARCHIVE.md 留一行索引
//   - 很久以前的事需要时先读 ARCHIVE.md，再按路径 Read 原文
//   - 若 config.privateDir 配了素材目录，顺带报一次占用与警戒线
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, statSync, appendFileSync, cpSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { homedir } from 'node:os';

const MEMORY_ROOT = process.env.CURATOR_ROOT || join(homedir(), '.dsh', 'memory');
const CONFIG_PATH = join(homedir(), '.dsh', 'memory-curator', 'config.json');
const LOG_PATH = join(homedir(), '.dsh', 'memory-curator', 'curator.log');
const DRY = process.argv.includes('--dry-run');

const DEFAULT_CONFIG = {
  halfLifeDays: 30,
  globalHotLimit: 24,
  projectHotLimit: 36,
  importanceDefault: 3,
  recentBoostDays: 7,
  recentBoost: 0.8,
  archiveAfterDays: 90,
  minHotScore: 0.5,
  // 可选的「素材目录额度检查」：填自己的素材目录，留空就跳过
  privateDir: 'D:\\Program Files (x86)\\DeepSeek AI',
  privateQuotaGB: 20,
  privateWarnAtGB: 18,
};

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function log(line) {
  const text = `【${stamp()}】${line}`;
  console.log(text);
  if (!DRY) {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, text + '\n', 'utf8');
  }
}

function parseFront(text) {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: text };
  const head = text.slice(3, end).split('\n');
  const meta = {};
  for (const line of head) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(end + 4) };
}

function readTitle(text, fallback) {
  const h = /^#\s+(.+)$/m.exec(text);
  return h ? h[1].trim() : fallback;
}

function listEntries(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY.md')
    .map((e) => join(dir, e.name));
}

function scoreEntry(file, cfg) {
  const st = statSync(file);
  const text = readFileSync(file, 'utf8');
  const { meta } = parseFront(text);
  const importance = Math.min(5, Math.max(1, Number(meta.importance) || cfg.importanceDefault));
  const ageDays = (Date.now() - st.mtimeMs) / 86400000;
  const decay = Math.pow(0.5, ageDays / cfg.halfLifeDays);
  const boost = ageDays <= cfg.recentBoostDays ? cfg.recentBoost : 0;
  return {
    file,
    name: basename(file),
    title: readTitle(text, meta.name || basename(file, '.md')),
    description: meta.description || '',
    importance,
    ageDays,
    chars: text.length,
    score: importance * decay + boost,
  };
}

function planScope(scopeRoot, label, cfg, limitKey) {
  const all = [];
  const perCategory = {};
  // 布局一：项目记忆是扁平的（memory/*.md + memory/MEMORY.md）
  const flat = listEntries(scopeRoot).map((f) => ({ ...scoreEntry(f, cfg), category: '' }));
  if (flat.length > 0) {
    perCategory[''] = flat;
    all.push(...flat);
  }
  // 布局二：全局记忆按分类子目录（global/<category>/*.md + MEMORY.md）
  const categories = readdirSync(scopeRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  for (const cat of categories) {
    if (cat === 'archive') continue;
    const entries = listEntries(join(scopeRoot, cat)).map((f) => ({ ...scoreEntry(f, cfg), category: cat }));
    if (entries.length === 0) continue;
    perCategory[cat] = entries;
    all.push(...entries);
  }
  const limit = cfg[limitKey];
  const minScore = cfg.minHotScore;
  const hotCandidates = all
    .filter((e) => e.ageDays < cfg.archiveAfterDays && e.score >= minScore)
    .sort((a, b) => b.score - a.score);
  const hot = new Set(hotCandidates.slice(0, limit).map((e) => e.file));
  const coldTooOld = all.filter((e) => !hot.has(e.file) && (e.ageDays >= cfg.archiveAfterDays || e.score < minScore));
  const coldOverflow = all.filter((e) => !hot.has(e.file) && !coldTooOld.includes(e) && e.ageDays < cfg.archiveAfterDays);
  return { label, scopeRoot, perCategory, all, hot, cold: all.filter((e) => !hot.has(e.file)), coldTooOld, coldOverflow, limit };
}

function archiveOne(entry, scopeRoot, cfg) {
  const d = new Date(statSync(entry.file).mtimeMs);
  const bucket = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const destDir = entry.category ? join(scopeRoot, 'archive', bucket, entry.category) : join(scopeRoot, 'archive', bucket);
  const dest = join(destDir, entry.name);
  if (!DRY) {
    mkdirSync(destDir, { recursive: true });
    renameSync(entry.file, dest);
    const indexFile = join(scopeRoot, 'archive', 'ARCHIVE.md');
    const line = `- [${bucket}] ${entry.category} / ${entry.title} — ${entry.description || '（无摘要）'} → ${relative(join(scopeRoot, 'archive'), dest).replace(/\\/g, '/')}\n`;
    mkdirSync(dirname(indexFile), { recursive: true });
    if (!existsSync(indexFile)) writeFileSync(indexFile, '# 冷存档索引（很久以前的记忆，按需检索）\n\n按月份分组，路径相对于本文件所在目录。\n\n', 'utf8');
    appendFileSync(indexFile, line, 'utf8');
  }
}

function rewriteIndex(plan) {
  for (const [cat, entries] of Object.entries(plan.perCategory)) {
    const indexFile = join(plan.scopeRoot, cat, 'MEMORY.md');
    if (!existsSync(indexFile)) continue;
    const original = readFileSync(indexFile, 'utf8');
    const keepLines = original
      .split('\n')
      .filter((line) => {
        const m = /\]\(([^)]+\.md)\)/.exec(line);
        if (!m) return !/^- \[/.test(line.trim()) ? true : true;
        const target = join(plan.scopeRoot, cat, m[1]);
        return plan.hot.has(target) || existsSync(target);
      });
    let next = keepLines.join('\n');
    const archiveDir = join(plan.scopeRoot, 'archive');
    const archiveIndex = join(archiveDir, 'ARCHIVE.md');
    const pointer = '- [更早的记忆（冷存档，按需 Read）](archive/ARCHIVE.md) — {{COLD}} 条，按月份归档；需要翻旧账时先读这里再按路径取原文。';
    next = next.replace(/\n*- \[更早的记忆[\s\S]*$/m, '');
    if (existsSync(archiveIndex)) {
      const coldCount = readdirSync(archiveDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')).length;
      next = next.trimEnd() + '\n' + pointer.replace('{{COLD}}', String(coldCount)) + '\n';
    }
    if (!DRY && next !== original) writeFileSync(indexFile, next, 'utf8');
  }
}

function dirSizeBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) {
      try { total += statSync(join(e.parentPath || dir, e.name)).size; } catch {}
    }
  }
  return total;
}

function checkPrivateDir(cfg) {
  const dir = cfg.privateDir;
  if (!dir) return; // 没配置就不查
  if (!existsSync(dir)) return log(`素材目录不存在：${dir}`);
  const bytes = dirSizeBytes(dir);
  const gb = bytes / 1073741824;
  const note = gb >= cfg.privateWarnAtGB ? `⚠️ 已超警戒线 ${cfg.privateWarnAtGB}G，建议清理旧素材` : '正常';
  log(`素材目录 ${dir}：${gb.toFixed(2)}G / ${cfg.privateQuotaGB}G（${note}）`);
}

function main() {
  const cfg = loadConfig();
  log(`开始整理记忆（${DRY ? 'dry-run' : '实跑'}），半衰期 ${cfg.halfLifeDays} 天，热区上限 全局 ${cfg.globalHotLimit} / 项目 ${cfg.projectHotLimit}`);

  const globalRoot = join(MEMORY_ROOT, 'global');
  const plans = [];
  if (existsSync(globalRoot)) plans.push(planScope(globalRoot, 'global', cfg, 'globalHotLimit'));

  const projectsRoot = join(MEMORY_ROOT, 'projects');
  if (existsSync(projectsRoot)) {
    for (const p of readdirSync(projectsRoot, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const root = join(projectsRoot, p.name, 'memory');
      if (existsSync(root)) plans.push(planScope(root, `project:${p.name}`, cfg, 'projectHotLimit'));
    }
  }

  for (const plan of plans) {
    log(`${plan.label}：共 ${plan.all.length} 条，热区留 ${plan.hot.size}，过老归档 ${plan.coldTooOld.length}，超额归档 ${plan.coldOverflow.length}`);
    for (const e of plan.coldTooOld) {
      log(`  归档（超龄 ${e.ageDays.toFixed(0)} 天，分 ${e.score.toFixed(2)}）：${e.category}/${e.name} ${e.title}`);
      archiveOne(e, plan.scopeRoot, cfg);
    }
    if (plan.coldOverflow.length > 0) {
      log(`  热区已满：${plan.coldOverflow.length} 条暂时留在原处（未到 ${cfg.archiveAfterDays} 天，不硬删）`);
    }
    rewriteIndex(plan);
  }

  const totalBytes = dirSizeBytes(MEMORY_ROOT);
  const totalMB = totalBytes / 1048576;
  log(`记忆根目录体积 ${totalMB.toFixed(1)}MB（${MEMORY_ROOT}）`);
  checkPrivateDir(cfg);

  const cfgPath = CONFIG_PATH;
  if (!existsSync(cfgPath) && !DRY) {
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    log(`已写入默认配置 ${cfgPath}`);
  }
  log('整理结束');
}

main();
