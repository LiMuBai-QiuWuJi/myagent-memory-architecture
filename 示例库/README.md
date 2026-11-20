# 示例库（最小可跑样本）

不是你的记忆，是一套**假数据**，用来验证你装对了没有。

```
示例库/
  projects/demo-lib/memory/
    MEMORY.md                          ← 四段式索引（由 budget.mjs 生成）
    _索引归档.md                        ← 挤出条目落点
    text-only-no-voice.md              ← feedback 类样本
    backup-before-merge.md             ← feedback 类样本
    search-index-first.md              ← project 类样本
    deprecated-by-date-2026-01.md      ← 「旧口径作废」写法样本
```

## 怎么跑

```powershell
# 1) 预算：把这个示例库重排一遍
$env:CURATOR_ROOT="<解压路径>\示例库"
node "<解压路径>\memory-curator\budget.mjs"

# 2) 检索：应命中 backup-before-merge.md
node "<解压路径>\memory-curator\search.mjs" "备份"

# 3) 闸门：故意写一句坏话，应报命中
"我们合并成一份再发你，晚安" | node "<解压路径>\memory-curator\guardrails.mjs" --lint -
```

期望输出：

- 第 1 步：`project:demo-lib：索引 4 条（悬空丢了 0），留 4，挤出 0，摘要 0 行，今天 0 行`
- 第 2 步：索引命中 2 条，至少一条指向 `backup-before-merge.md`；没有 `embeddings.json` 时会提示「向量兜底没走成」，**这是正常的**
- 第 3 步：报出 `A2-换包装重发` / `D13-道晚安` 之类的命中行

## 注意

- 这个目录**不要**和你的真实记忆库混用；跑完记得清掉 `$env:CURATOR_ROOT`
- 样本文件的 mtime 特意设成 3 天前，好让它们落在「记忆索引」而不是「今天内容」——这样四段结构一眼能看全
