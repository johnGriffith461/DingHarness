import { describe, expect, it } from "vitest";
import {
  CODING_DETAIL_LABELS,
  isLiked,
  likeLabel,
  normalizeLiked,
  toggleLiked,
  CODING_CATEGORIES,
  CODING_LABELS,
  CODING_TIME_SLOTS,
  appNameOf,
  categoryOptions,
  filterApps,
  guessCategory,
  isWebApp,
  moreFromLine,
  rankApps,
  remixPrompt,
  searchResultLabel,
  timeSlotLabel,
  type CodingApp,
} from "@shared/coding";

/**
 * 创作广场 / 应用生成（§159）。
 *
 * 断言对着 `docs/evidence-coding.txt`（`coding_*` 260 条）。  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 * 那 260 条里大半是云端功能（投稿审核 / 挑战赛 / 举报 / 跨用户排行），这里**不测**那些 ——
 * 本机版做的是**有本地含义的那一部分**（见 `shared/coding.ts` 开头那张对照表）。
 */
const app = (patch: Partial<CodingApp> = {}): CodingApp => ({
  name: "数据看板",
  path: "D:/x/数据看板.html",
  bytes: 1000,
  updatedAt: 1000,
  category: "数据看板",
  ...patch,
});

describe("文案与本体对齐（逐字取自 coding_* 证据）", () => {
  it("广场与几个动作", () => {
    expect(CODING_LABELS.center).toBe("创作广场");
    expect(CODING_LABELS.createApp).toBe("创作应用");
    expect(CODING_LABELS.preview).toBe("预览应用");
    expect(CODING_LABELS.remix).toBe("创作同款");
    expect(CODING_LABELS.detail).toBe("查看详情");
    expect(CODING_LABELS.introduction).toBe("应用介绍");
    expect(CODING_LABELS.topApps).toBe("Top 应用排行");
    expect(CODING_LABELS.more).toBe("查看更多");
  });

  it("搜索那三句", () => {
    expect(CODING_LABELS.search).toBe("搜索应用");
    expect(CODING_LABELS.searchNone).toBe("暂未搜索到匹配的应用");
    expect(CODING_LABELS.searchResult).toBe("找到 {s_number} 个应用");
  });

  it("两个模式与那句占位（问答模式是 coding 的入口之一）", () => {
    expect(CODING_LABELS.createMode).toBe("创作模式");
    expect(CODING_LABELS.chatMode).toBe("问答模式");
    expect(CODING_LABELS.chatPlaceholder).toBe('输入"@"唤起常用语，或粘贴代码快速提问');
  });

  it("合规那两句（本地部署与用户已编辑）", () => {
    expect(CODING_LABELS.safeTips).toBe("本地部署，注意内容合规与信息安全");
    expect(CODING_LABELS.editedTips).toBe("用户已编辑");
  });

  it("七个分类逐字且顺序一致", () => {
    expect(CODING_CATEGORIES).toEqual([
      "数据看板",
      "教育培训",
      "游戏娱乐",
      "其他",
      "汇报演示",
      "效率工具",
      "网站设计",
    ]);
  });
});

describe("分类与时间", () => {
  it("下拉含「全部」+ 七类", () => {
    const opts = categoryOptions();
    expect(opts[0]).toEqual({ value: "all", label: "全部" });
    expect(opts).toHaveLength(8);
  });

  it("时间范围的说法", () => {
    expect(CODING_TIME_SLOTS).toEqual([7, 30, 0]);
    expect(timeSlotLabel(7)).toBe("近 7 天");
    expect(timeSlotLabel(0)).toBe("全部时间");
  });
});

describe("guessCategory（本机版是**猜**的，猜不中归「其他」）", () => {
  it("关键词命中各自那一类", () => {
    expect(guessCategory("销售数据看板")).toBe("数据看板");
    expect(guessCategory("英语单词学习")).toBe("教育培训");
    expect(guessCategory("贪吃蛇小游戏")).toBe("游戏娱乐");
    expect(guessCategory("季度汇报 PPT")).toBe("汇报演示");
    expect(guessCategory("番茄钟工具")).toBe("效率工具");
    expect(guessCategory("产品官网落地页")).toBe("网站设计");
  });

  it("⭐ 猜不中归「其他」（证据里本来就有这一类）", () => {
    expect(guessCategory("x9f2k")).toBe("其他");
  });

  it("英文名也认（大小写不敏感）", () => {
    expect(guessCategory("MyDashboard")).toBe("数据看板");
    expect(guessCategory("LANDING-page")).toBe("网站设计");
  });
});

describe("filterApps", () => {
  const DAY = 24 * 3600 * 1000;
  const NOW = 100 * DAY;
  const list = [
    app({ name: "销售看板", category: "数据看板", updatedAt: NOW - 1 * DAY }),
    app({ name: "单词学习", category: "教育培训", updatedAt: NOW - 10 * DAY }),
    app({ name: "贪吃蛇", category: "游戏娱乐", updatedAt: NOW - 100 * DAY }),
  ];

  it("不筛就全给（但要是新数组）", () => {
    const got = filterApps(list, {});
    expect(got).toHaveLength(3);
    expect(got).not.toBe(list);
  });

  it("按分类筛", () => {
    expect(filterApps(list, { category: "游戏娱乐" }).map((a) => a.name)).toEqual(["贪吃蛇"]);
  });

  it("按关键词筛（大小写不敏感）", () => {
    expect(filterApps(list, { query: "学习" }).map((a) => a.name)).toEqual(["单词学习"]);
  });

  it("⭐ 时间范围是**真的按天数切**（不是只显示个标签）", () => {
    // 近 7 天：只剩 1 天前那条
    expect(filterApps(list, { days: 7, now: NOW }).map((a) => a.name)).toEqual(["销售看板"]);
    // 近 30 天：多出 10 天前那条
    expect(filterApps(list, { days: 30, now: NOW }).map((a) => a.name)).toEqual(["销售看板", "单词学习"]);
  });

  it("不限时间（days = 0）就不按时间切", () => {
    expect(filterApps(list, { days: 0, now: NOW })).toHaveLength(3);
  });

  it("分类 + 关键词 + 时间可以叠", () => {
    const got = filterApps(list, { category: "数据看板", query: "看板", days: 30, now: NOW });
    expect(got.map((a) => a.name)).toEqual(["销售看板"]);
  });
});

describe("searchResultLabel", () => {
  it("有命中就说数量，没有就用证据里那句", () => {
    expect(searchResultLabel(3)).toBe("找到 3 个应用");
    expect(searchResultLabel(0)).toBe("暂未搜索到匹配的应用");
  });
});

describe("rankApps（⭐ 本机版口径：按最近更新）", () => {
  const list = [app({ name: "旧", updatedAt: 1 }), app({ name: "新", updatedAt: 9 }), app({ name: "中", updatedAt: 5 })];

  it("新的在前", () => {
    expect(rankApps(list).map((a) => a.name)).toEqual(["新", "中", "旧"]);
  });

  it("取前 N 个", () => {
    expect(rankApps(list, 2)).toHaveLength(2);
  });

  it("同一时间按名字兜底（顺序要稳定）", () => {
    expect(rankApps([app({ name: "b", updatedAt: 5 }), app({ name: "a", updatedAt: 5 })]).map((a) => a.name)).toEqual([
      "a",
      "b",
    ]);
  });

  it("不改原数组", () => {
    const src = [app({ name: "旧", updatedAt: 1 }), app({ name: "新", updatedAt: 9 })];
    rankApps(src);
    expect(src.map((a) => a.name)).toEqual(["旧", "新"]);
  });
});

describe("remixPrompt（「创作同款」填回输入区的那句话）", () => {
  it("带上名字与分类，且是**能直接开工**的委托", () => {
    const p = remixPrompt(app({ name: "销售看板", category: "数据看板" }));
    expect(p).toContain("销售看板");
    expect(p).toContain("数据看板");
    expect(p).toContain("单文件 HTML");
  });

  it("是第二人称的委托（不是复述标题）", () => {
    expect(remixPrompt(app())).toContain("照着");
  });
});

describe("应用识别与命名", () => {
  it("只认网页（.html / .htm）", () => {
    expect(isWebApp("看板.html")).toBe(true);
    expect(isWebApp("看板.HTM")).toBe(true);
    expect(isWebApp("看板.md")).toBe(false);
    expect(isWebApp("看板.png")).toBe(false);
  });

  it("应用名去掉扩展名", () => {
    expect(appNameOf("销售看板.html")).toBe("销售看板");
  });

  it("「更多来自于」那一行", () => {
    expect(moreFromLine("我")).toBe("更多来自于 我");
  });
});


describe("应用详情与喜欢（§180）", () => {
  it("文案逐字取自证据", () => {
    expect(CODING_DETAIL_LABELS.detail).toBe("查看详情");
    expect(CODING_DETAIL_LABELS.detailTab).toBe("应用详情");
    expect(CODING_DETAIL_LABELS.like).toBe("喜欢");
    expect(CODING_DETAIL_LABELS.unlike).toBe("取消喜欢");
  });

  it("切换喜欢：没喜欢的加进去", () => {
    expect(toggleLiked([], "日报生成器")).toEqual(["日报生成器"]);
    expect(toggleLiked(["甲"], "乙")).toEqual(["甲", "乙"]);
  });

  it("切换喜欢：已喜欢的去掉", () => {
    expect(toggleLiked(["甲", "乙"], "甲")).toEqual(["乙"]);
  });

  it("⭐ 切换是**纯函数**（不改原数组）—— 界面靠它做乐观更新", () => {
    const src = ["甲"];
    toggleLiked(src, "乙");
    expect(src).toEqual(["甲"]);
  });

  it("名字是空的就原样返回（不往名单里塞空串）", () => {
    expect(toggleLiked(["甲"], "")).toEqual(["甲"]);
    expect(toggleLiked(["甲"], "   ")).toEqual(["甲"]);
  });

  it("名字前后空格会被清掉（否则同一个应用能被喜欢两次）", () => {
    expect(toggleLiked([], "  日报  ")).toEqual(["日报"]);
    expect(toggleLiked(["日报"], " 日报 ")).toEqual([]);
  });

  it("按钮那句话跟着状态变", () => {
    expect(likeLabel(false)).toBe("喜欢");
    expect(likeLabel(true)).toBe("取消喜欢");
  });

  it("isLiked 判断的是清过空格的名字", () => {
    expect(isLiked(["日报"], " 日报 ")).toBe(true);
    expect(isLiked(["日报"], "周报")).toBe(false);
  });
});

describe("恢复喜欢名单（§180）", () => {
  it("正常的一份原样活着", () => {
    expect(normalizeLiked({ liked: ["甲", "乙"] })).toEqual(["甲", "乙"]);
  });

  it("⭐ 也接受裸数组（写盘时是 `{liked:[...]}`，但旧数据/手改可能是数组）", () => {
    expect(normalizeLiked(["甲"])).toEqual(["甲"]);
  });

  it("非数组 / 坏文件 → 空名单（不让坏文件把应用卡住）", () => {
    expect(normalizeLiked(null)).toEqual([]);
    expect(normalizeLiked({})).toEqual([]);
    expect(normalizeLiked({ liked: "甲" })).toEqual([]);
    expect(normalizeLiked("[]")).toEqual([]);
  });

  it("逐项只留非空字符串，并去重", () => {
    expect(normalizeLiked({ liked: ["甲", 42, null, " 甲 ", "", "乙"] })).toEqual(["甲", "乙"]);
  });
});
