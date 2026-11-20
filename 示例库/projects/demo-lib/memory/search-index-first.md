---
name: search-index-first
description: 检索先查索引，0 命中才降级走向量
metadata:
  type: project
---
索引命中即确定；只有一条都没命中时才走向量，向量结果只当候选，不当证据。
