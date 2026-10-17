# 本地知识库（RAG）

```bash
ding knowledge add ./docs --domain team
ding knowledge search 报销流程 --limit 5
ding knowledge ask "差旅报销的上限是多少？"     # 真模型 + 引用（会花钱）
ding knowledge list
ding knowledge remove ./docs/报销.md
```

## 它是什么

- **本地索引**：`<数据目录>/knowledge.db`（SQLite）。删索引不删原文件，随时可重建。
- **带引用**：每条命中给「标题 + 路径 + 第几段」；`ask` 要求模型用 `[n]` 标注来源，
  回答末尾列出来源。没有引用标记会明确警告。
- **两域权限**：`private` 只有 `owner` 能搜到；`team` 所有人可见。
  **过滤发生在检索层** —— 不是搜出来再藏。

## 支持哪些格式

`.md` / `.markdown` / `.txt` / `.json` / `.csv` / `.tsv` / `.log` / `.yaml` / `.yml` /
`.html` / `.docx`；`.pdf` 需要本机有 `pdftotext`（poppler-utils）。

不支持就**明确报错**，不把二进制乱码索引进去。

## 为什么不是向量库

50 页文档用 FTS5 + LIKE 混合是毫秒级，且零模型调用、零额外依赖。
需要语义近似（"报销流程"命中"费用审批步骤"）或上千页时再上向量库 ——
**索引格式与引用结构不用变**，换的是 recall 实现。

## 边界

- 扫描版 PDF / 纯图片 DOCX 抽不出文字（需要先 OCR）。
- `ask` 只用检索到的片段，不做多跳推理；资料里没有它会说没有。
- 目前只有 CLI 入口；桌面端与 agent 工具接线还没做。
