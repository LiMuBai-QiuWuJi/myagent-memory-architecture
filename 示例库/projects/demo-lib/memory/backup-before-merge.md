---
name: backup-before-merge
description: 批量合并/改名之前先整库备份，改完逐字节比对
metadata:
  type: feedback
---
## Why
批量改文件名一旦错，原文找不回来。

## How to apply
先把整库复制到 backup-<时间>/，跑合并，再用 cmp 抽查 5 个文件确认未动。
