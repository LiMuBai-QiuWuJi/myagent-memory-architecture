#!/usr/bin/env node
// Windows 计划任务入口（DSH-Memory-Curator 04:00）：全部逻辑在 daily.mjs
// curate-core.mjs 是原来的遗忘曲线整理器，daily.mjs 依次跑 budget → core → git 备份
import('./daily.mjs');
