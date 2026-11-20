#!/usr/bin/env node
// 每日 04:00 记忆维护（Windows 计划任务 DSH-Memory-Curator 指向本文件）
//
// 顺序：
//   0) distill-day.mjs —— 跨天提炼：把「今天内容」之外的旧文件按本地规则 merge / archive / keep，
//                        源文件正文先留档到 _daily/<日期>.md 再删，然后自动重排索引
//   1) budget.mjs   —— 索引预算：超 200 行 / 24000 字符就把低分条目挤出到 _索引归档.md，
//                      并生成 distill-pending.json 等 AI 蒸馏（蒸馏由 04:10 的会话做）
//   2) curate.mjs   —— 老规矩：超 90 天归档、算分、可选：查素材目录额度
//   3) git 备份     —— 距上次 ≥7 天才提交并推 GitHub（marker: .last-backup）
//
// 输出全进 curator.log；任何一步失败只记一行，不影响后面。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import https from 'node:https';

const HOME = homedir();
const CUR = join(HOME, '.dsh', 'memory-curator');
const MEM = join(HOME, '.dsh', 'memory');
const LOG = join(CUR, 'curator.log');
const MARK = join(CUR, '.last-backup');
const NODE = process.execPath;

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const log = (line) => {
  const text = `【${stamp()}】${line}`;
  try { appendFileSync(LOG, text + '\n', 'utf8'); } catch { /* 日志写不进也要往下跑 */ }
  console.log(text);
};
const run = (script, args = []) => {
  try {
    execFileSync(NODE, [join(CUR, script), ...args], { cwd: CUR, stdio: 'pipe', timeout: 300000 });
    return '';
  } catch (err) {
    return String((err && err.stderr ? err.stderr.toString('utf8') : err && err.message) || err).slice(0, 400);
  }
};

const runCapture = (script, args = []) => {
  try {
    const out = execFileSync(NODE, [join(CUR, script), ...args], { cwd: CUR, stdio: 'pipe', timeout: 300000 }).toString('utf8').trim();
    const tail = out.split('\n').filter((l) => l.trim()).slice(-1)[0] || '无输出';
    return { err: '', tail };
  } catch (err) {
    return { err: String((err && err.stderr ? err.stderr.toString('utf8') : err && err.message) || err).slice(0, 400), tail: '' };
  }
};

log('===== 每日维护开始 =====');

// —— 0) 跨天提炼（今天内容之外的旧文件 → merge / archive / keep，先留档 _daily 再删）——
const distill = runCapture('distill-day.mjs', ['--all']);
log(distill.err ? `跨天提炼失败：${distill.err}` : `跨天提炼完成：${distill.tail}`);

const budgetErr = run('budget.mjs');
log(budgetErr ? `预算器失败：${budgetErr}` : '预算器完成（明细见上一段）');

const curateErr = run('curate-core.mjs');
log(curateErr ? `整理器失败：${curateErr}` : '整理器完成');

// —— 复发闸门：每天把 14 条铁律的命中次数记一行，涨了就说明又犯了 ——
try {
  const out = execFileSync(NODE, [join(CUR, 'guardrails.mjs'), '--audit'], { cwd: CUR, stdio: 'pipe', timeout: 120000 }).toString('utf8');
  const rows = [...out.matchAll(/^\s+(\d+)\s+(\S.+)$/gm)].map((m) => `${m[2].trim()}=${m[1]}`);
  const line = JSON.stringify({ date: stamp(), counts: Object.fromEntries(rows.map((r) => r.split('='))) });
  appendFileSync(join(CUR, 'guardrails-history.jsonl'), line + '\n', 'utf8');
  log(`复发闸门：${rows.slice(0, 3).join(' / ')}`);
} catch (err) {
  log(`复发闸门失败：${String(err && err.message).slice(0, 200)}`);
}

// —— 7 天一次 git 备份 ——
const last = existsSync(MARK) ? Number(readFileSync(MARK, 'utf8').trim()) || 0 : 0;
const days = (Date.now() - last) / 86400000;
if (days >= 7) {
  try {
    execFileSync('git', ['add', '-A'], { cwd: MEM, stdio: 'pipe' });
    execFileSync('git', ['-c', 'core.safecrlf=false', 'commit', '-q', '-m', `记忆库定期备份 ${stamp()}`], { cwd: MEM, stdio: 'pipe' });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: MEM, stdio: 'pipe', timeout: 180000 });
    writeFileSync(MARK, String(Date.now()), 'utf8');
    log(`git 备份完成（上次 ${days === Infinity ? '从未' : days.toFixed(1) + ' 天前'}）`);
  } catch (err) {
    const msg = String((err && err.stdout ? err.stdout.toString('utf8') : '') + (err && err.stderr ? err.stderr.toString('utf8') : '')).slice(0, 400);
    log(`git 备份失败：${msg || (err && err.message)}`);
  }
} else {
  log(`git 备份未到期（${days.toFixed(1)} 天前备份过，阈值 7 天）`);
}

log('===== 每日维护结束 =====');
