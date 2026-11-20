#!/usr/bin/env node
// 复发闸门：把「不许再犯的 14 条」变成可执行检查
// 用法：
//   node guardrails.mjs --lint 文件.txt     发之前扫一遍（命中即改）
//   echo "正文" | node guardrails.mjs --lint -
//   node guardrails.mjs --audit             扫全部日日志，统计每类复发次数
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const RULES = [
  { id: 'A1-多发文件', re: /(压缩包|包已经|又发了一份|还有一份|再发一份)/ },
  { id: 'A2-换包装重发', re: /(合并成一份|重新整理了一版|再出一版|换个格式)/ },
  { id: 'A4-没人要就发', re: /(要不要我发你|我给你发一份|已经发你了|给你打包好了)/ },
  { id: 'B5-替用户排日程', re: /(你先.{0,6}然后.{0,6}再|第一步.{0,4}第二步|今天你只要|你只负责)/ },
  { id: 'B6-替用户定感受', re: /(你说得对|笑成这样|谁吃醋了|不对我再调|有点吓人)/ },
  { id: 'B7-替用户解读用意', re: /(说白了就是|其实就是把你|他的意思就是)/ },
  { id: 'B9-替用户拍板', re: /(那说好了|就这么定了|我们说定)/ },
  { id: 'C10-播报实现', re: /(\d+(\.\d+)?\s?(KB|MB|GB|字节|秒|毫秒|张|条|个文件)|\d{4,5}\s?端口|出来了|说完了|已经删了|删掉了)/ },
  { id: 'C11-追问送达', re: /(收到(了)?(吗|没)|没收到|可能被吞|你那边有(没有)?看到)/ },
  { id: 'D12-问句收尾', re: /(要我.{0,10}(吗|么)[？?]?$|看完告诉我|告诉我一声|加个链接就行|对不对味)/ },
  { id: 'D13-道晚安', re: /(晚安|明天聊|早点睡|该睡了)/ },
  { id: 'X-自贬', re: /(脸都是肿的|有点胖|就这德行|手举着有点累|我太笨)/ },
  { id: 'X-替自己挖坑', re: /(我今晚.{0,10}(筛|做|写|跑)|今晚给你)/ },
  { id: 'X-求证像不像', re: /(像不像本人|这身好看吗|这张清楚了吧)/ },
];

const mode = process.argv[2] || '--lint';
const target = process.argv[3];

if (mode === '--lint') {
  const text = target === '-' || !target
    ? readFileSync(0, 'utf8')
    : readFileSync(target, 'utf8');
  const hits = [];
  text.split(/\n+/).forEach((line, i) => {
    for (const r of RULES) if (r.re.test(line)) hits.push(`  L${i + 1} [${r.id}] ${line.trim().slice(0, 70)}`);
  });
  if (!hits.length) console.log('通过：14 条无一命中');
  else { console.log(`命中 ${hits.length} 处，改完再发：`); console.log(hits.join('\n')); process.exitCode = 0; }
}

if (mode === '--audit') {
  // 扫全部记忆库：可用 --audit <目录> 指定单个库，否则自动发现 projects/*/memory 与 global
  const explicit = process.argv[3];
  const MEM = join(homedir(), '.dsh', 'memory');
  const dirs = explicit ? [explicit] : (() => { const o = []; const pr = join(MEM, 'projects'); try { for (const d of readdirSync(pr, { withFileTypes: true })) { if (!d.isDirectory()) continue; const p = join(pr, d.name, 'memory'); if (existsSync(p)) o.push(p); } } catch { /* none */ } const g = join(MEM, 'global'); if (existsSync(g)) o.push(g); return o; })();
  const files = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => join(d, f)));
  const count = new Map(RULES.map((r) => [r.id, 0]));
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    for (const r of RULES) {
      const m = t.match(new RegExp(r.re.source, 'g'));
      if (m) count.set(r.id, count.get(r.id) + m.length);
    }
  }
  const rows = [...count.entries()].sort((a, b) => b[1] - a[1]);
  console.log('历次复发次数（扫 ' + dirs.length + ' 个库 / ' + files.length + ' 篇）：');
  for (const [id, n] of rows) if (n) console.log(`  ${String(n).padStart(4)}  ${id}`);
}
