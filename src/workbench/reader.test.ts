import { describe, expect, it } from "vitest";
import {
  LINES_PER_PAGE,
  READER_LABELS,
  READER_TABS,
  extractCharts,
  findHits,
  normalizeReadings,
  pageOfLine,
  parseOutline,
  readingStats,
  readingTitle,
} from "@shared/reader";

/**
 * AI 阅读的纯逻辑（§155）。
 *
 * 三件事（大纲 / 页面检索 / 图表）在本地都**算得准**，所以它们是这一版的主体：
 * 不依赖模型、也不依赖网络。文案断言对着 `docs/evidence-readweb.txt`。
 */
const DOC = [
  "# 季度复盘",
  "",
  "本季度整体完成度不错。",
  "",
  "## 数据",
  "",
  "| 指标 | 数值 |",
  "| --- | --- |",
  "| 收入 | 120 |",
  "| 成本 | 80 |",
  "",
  "![折线图](img/trend.png)",
  "",
  "## 结论",
  "",
  "继续保持。",
].join("\n");

describe("文案与本体对齐（逐字取自 copilot_* 证据）", () => {
  it("入口与侧栏", () => {
    expect(READER_LABELS.enter).toBe("进入 AI 阅读");
    expect(READER_LABELS.hideSidebar).toBe("隐藏侧栏");
    expect(READER_LABELS.recent).toBe("最近阅读");
  });

  it("三个页签与它们的说明", () => {
    expect(READER_TABS).toEqual(["outline", "page", "chart"]);
    expect(READER_LABELS.outline).toBe("大纲");
    expect(READER_LABELS.page).toBe("页面");
    expect(READER_LABELS.chart).toBe("图表");
    expect(READER_LABELS.descOutline).toBe("智能展示文件的大纲结构");
    expect(READER_LABELS.descPage).toBe("页面检索");
    expect(READER_LABELS.descChart).toBe("展示文件中包含的图片表格");
  });
});

describe("折页口径", () => {
  it("第 1 行在第 1 页，第 N+1 行翻页", () => {
    expect(pageOfLine(1)).toBe(1);
    expect(pageOfLine(LINES_PER_PAGE)).toBe(1);
    expect(pageOfLine(LINES_PER_PAGE + 1)).toBe(2);
  });

  it("越界的行号也给个合理值（不返回 0 或 NaN）", () => {
    expect(pageOfLine(0)).toBe(1);
    expect(pageOfLine(-5)).toBe(1);
  });
});

describe("parseOutline", () => {
  it("按出现顺序抽出层级与标题", () => {
    const got = parseOutline(DOC);
    expect(got.map((o) => [o.level, o.text])).toEqual([
      [1, "季度复盘"],
      [2, "数据"],
      [2, "结论"],
    ]);
  });

  it("带上行号（点大纲要能跳过去）", () => {
    expect(parseOutline(DOC)[0]?.line).toBe(1);
    expect(parseOutline(DOC)[1]?.line).toBe(5);
  });

  it("⭐ 代码块里的 # 不算标题（那是注释）", () => {
    const text = "# 标题\n\n```bash\n# 这只是注释\n## 也不是标题\n```\n\n## 真标题";
    expect(parseOutline(text).map((o) => o.text)).toEqual(["标题", "真标题"]);
  });

  it("没有标题时给空数组（界面自己说「没有标题层级」）", () => {
    expect(parseOutline("就是一段普通文字。")).toEqual([]);
  });

  it("六级标题都认，且能让出层级数", () => {
    const got = parseOutline("###### 六级");
    expect(got[0]?.level).toBe(6);
  });
});

describe("findHits（页面检索）", () => {
  it("空关键词给空结果 —— 别把「没输」当成「全中」", () => {
    expect(findHits(DOC, "")).toEqual([]);
    expect(findHits(DOC, "   ")).toEqual([]);
  });

  it("找到命中并带页号与行号", () => {
    const got = findHits(DOC, "收入");
    expect(got).toHaveLength(1);
    expect(got[0]?.text).toContain("收入");
    expect(got[0]?.page).toBe(1);
  });

  it("大小写不敏感（英文检索的常态）", () => {
    expect(findHits("Hello World", "hello")).toHaveLength(1);
  });

  it("同一行出现多次只算一处（用户要的是位置，不是次数）", () => {
    expect(findHits("重复重复重复", "重复")).toHaveLength(1);
  });

  it("长行截断，免得把列表撑爆", () => {
    const long = `关键词${"字".repeat(200)}`;
    expect((findHits(long, "关键词")[0]?.text ?? "").length).toBeLessThanOrEqual(81);
  });

  it("超过上限就停（避免几万条把界面卡死）", () => {
    const many = Array.from({ length: 120 }, () => "命中").join("\n");
    expect(findHits(many, "命中", LINES_PER_PAGE, 10)).toHaveLength(10);
  });
});

describe("extractCharts", () => {
  it("抽出表格，并数出行数", () => {
    const got = extractCharts(DOC);
    expect(got.tables).toHaveLength(1);
    expect(got.tables[0]?.header).toEqual(["指标", "数值"]);
    expect(got.tables[0]?.rows).toBe(2);
    expect(got.tables[0]?.page).toBe(1);
  });

  it("数出图片张数", () => {
    expect(extractCharts(DOC).images).toBe(1);
  });

  it("⭐ 只有竖线的句子**不算**表格（要有分隔行才算）", () => {
    expect(extractCharts("这句话 | 有个竖线\n但下一行不是分隔行").tables).toEqual([]);
  });

  it("没有图表时两个都是空/零（界面自己说「没有表格或图片」）", () => {
    const got = extractCharts("干干净净的一段话。");
    expect(got.tables).toEqual([]);
    expect(got.images).toBe(0);
  });

  it("多个表格都抽到", () => {
    const text = "| a |\n| --- |\n| 1 |\n\n文字\n\n| b |\n| --- |\n| 2 |\n| 3 |";
    expect(extractCharts(text).tables.map((t) => t.rows)).toEqual([1, 2]);
  });
});

describe("readingStats 与标题", () => {
  it("统计字数（不算空白）、段落数、标题数", () => {
    const got = readingStats(DOC);
    expect(got.headings).toBe(3);
    expect(got.paragraphs).toBeGreaterThan(3);
    expect(got.chars).toBeGreaterThan(20);
  });

  it("标题优先取第一个 Markdown 标题", () => {
    expect(readingTitle(DOC)).toBe("季度复盘");
  });

  it("没有标题就取第一行非空文本", () => {
    expect(readingTitle("\n\n 就这样一段 \n第二行")).toBe("就这样一段");
  });

  it("彻底空的内容给个兜底名", () => {
    expect(readingTitle("   ")).toBe("未命名内容");
  });

  it("标题过长会截断", () => {
    expect(readingTitle(`# ${"长".repeat(60)}`).length).toBe(40);
  });
});

describe("normalizeReadings（磁盘不可信）", () => {
  it("坏数据丢掉，好数据保住", () => {
    const got = normalizeReadings([{ id: "a", text: "甲", at: 2 }, null, { text: "没有 id" }, { id: "b", text: "乙", at: 1 }]);
    expect(got.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("按时间新的在前", () => {
    const got = normalizeReadings([{ id: "old", text: "x", at: 1 }, { id: "new", text: "y", at: 9 }]);
    expect(got[0]?.id).toBe("new");
  });

  it("超过上限只留最近的（不然文件会一直涨）", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, text: "x", at: i }));
    expect(normalizeReadings(many, 5)).toHaveLength(5);
  });

  it("没有标题时用内容补一个", () => {
    expect(normalizeReadings([{ id: "a", text: "# 甲\n内容", at: 1 }])[0]?.title).toBe("甲");
  });

  it("不是数组就给空", () => {
    expect(normalizeReadings("不是数组")).toEqual([]);
    expect(normalizeReadings(null)).toEqual([]);
  });
});
