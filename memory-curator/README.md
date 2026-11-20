# memory-curator · 九个脚本

零依赖，只用 Node 内置模块。全部支持 Windows / macOS / Linux（路径用 `home` 推导，可用环境变量覆盖）。

| 脚本 | 何时跑 | 一句话 |
|---|---|---|
| `budget.mjs` | 索引变了就值一次 | 把 `MEMORY.md` 重排成「摘要区 + 今天内容 + 记忆索引 + 外部指针」四段，挤出去进 `_索引归档.md` |
| `daily.mjs` | 每天 04:00 | 提炼 → 预算 → 遗忘曲线 → git 备份（≥7 天一次）的总调度 |
| `curate.mjs` | 计划任务的入口 | 4 行薄壳，指向 `daily.mjs`；指向它以后改 daily 不用改任务 |
| `curate-core.mjs` | 由 daily 调 | 遗忘曲线打分 + 90 天归档；可选检查一个素材目录的占用 |
| `distill-day.mjs` | 跨天 / 手动 | 把旧的记忆文件按内容分类 merge / archive / keep，原文先留档到 `_daily/` |
| `search.mjs` | 需要回忆时 | 两级检索：索引文本 → 向量兜底（bge-m3 1024 维） |
| `fixlinks.mjs` | 合并或改名之后 | 修 `[[死链]]`；拿不准的只报不改 |
| `guardrails.mjs` | 发长文之前 / 每天审计 | 14 组正则，把「踩过的坑」变成可执行检查 |
| `merge-index-cleanup.mjs` | 合并一簇记忆之后 | 删指向已删文件的索引行、补新 merged 文件的索引行 |

## 环境变量

| 变量 | 作用 |
|---|---|
| `CURATOR_ROOT` | 覆盖记忆根（默认 `~/.dsh/memory`）；`budget` / `curate-core` / `search` / `distill-day` 都认 |
| `MYAGENT_ROOT` | 只有和档案库插件配套时才用（那是另一套东西，不是记忆架构必需的） |

## 配置

`config.json`（缺失时由 `install.mjs` 从 `config.example.json` 生成，已存在则永不覆盖）：

```json
{
  "halfLifeDays": 30,
  "globalHotLimit": 16,
  "projectHotLimit": 24,
  "importanceDefault": 3,
  "recentBoostDays": 7,
  "recentBoost": 0.8,
  "archiveAfterDays": 90,
  "privateDir": "",
  "privateQuotaGB": 20,
  "privateWarnAtGB": 18
}
```

- `halfLifeDays` 越小，旧记忆掉热区越快
- `privateDir` 留空就跳过素材目录检查
- 所有常量（索引行数、字符上限、摘要行数、提炼分类表、闸门正则）都在**各脚本文件顶部**，改完跑一次 `node --check`

## 三条纪律

1. **不要改 `MEMORY.md` 的四段顺序** —— 预算器和提炼器按顺序解析
2. **不要手编索引行** —— 交给 `budget.mjs`；手编的会被预算重排
3. **跑提炼前先 `--dry-run`** —— 它会删源文件（正文已留档，但文件名没了）
