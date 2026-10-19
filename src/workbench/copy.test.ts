import { describe, expect, it } from "vitest";
import { ARTIFACT_TITLE_GENERATING, CODING_SUGGESTION_POOL, COMPOSER_PLACEHOLDER, HOME_GREETING, HOME_MODES, HOME_MODE_KEY, HOME_TITLE, SCHEDULED_RECOMMEND, SCHEDULED_SERVED_IDS, SCHEDULE_COMPOSER_PLACEHOLDER, SUGGESTION_COUNT, SUGGESTION_POOL, SUMMARY_TABS, TASK_TITLE_LIMIT, parseHomeMode, pickSuggestions, splitSuggestion, suggestionsFor } from "./copy";

/**
 * 文案表保真。
 *
 * 这一组不是为了覆盖率，而是**防止文案被"顺手改顺眼"** ——
 * 这些值是只读地从上位 i18n 表里取出来的，键名即契约。
 * 谁要改，得先去原包对 key，而不是凭感觉润色。
 */
describe("SCHEDULED_RECOMMEND —— 定时任务推荐卡（id → 文案）", () => {
  it("是 9 条（上位 i18n 里 title_1..9 全在）", () => {
    expect(SCHEDULED_RECOMMEND).toHaveLength(9);
    expect(SCHEDULED_RECOMMEND.map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("每条都有 i18n 键、标题、说明", () => {
    for (const item of SCHEDULED_RECOMMEND) {
      expect(item.titleKey, String(item.id)).toMatch(/^scheduledTasks_recommend_title_\d$/);
      expect(item.title.length, String(item.id)).toBeGreaterThan(0);
      expect(item.summary.length, String(item.id)).toBeGreaterThan(0);
    }
  });

  it("标题与上位逐条一致（抽查几条容易记错的）", () => {
    const byId = new Map(SCHEDULED_RECOMMEND.map((i) => [i.id, i]));
    // 我实机只看到 7 张，漏掉的正是 1、2 —— 这两条是回归重点
    expect(byId.get(1)?.title).toBe("工作周报");
    expect(byId.get(2)?.title).toBe("每日安排简报");
    expect(byId.get(3)?.title).toBe("每日新闻推送");
    expect(byId.get(9)?.title).toBe("商品价格监控");
    expect(byId.get(9)?.summary).toBe("持续追踪心仪商品到手价，达到目标价格时即时提醒");
  });
});

describe("SCHEDULED_SERVED_IDS —— 服务端这一次实际发的清单", () => {
  it("是 7 条，且都是超集里的成员", () => {
    expect(SCHEDULED_SERVED_IDS).toHaveLength(7);
    const ids = SCHEDULED_RECOMMEND.map((i) => i.id);
    for (const id of SCHEDULED_SERVED_IDS) expect(ids).toContain(id);
  });

  it("1、2 不在实发清单里（这正是实机只看到 7 张的原因）", () => {
    expect(SCHEDULED_SERVED_IDS as readonly number[]).not.toContain(1);
    expect(SCHEDULED_SERVED_IDS as readonly number[]).not.toContain(2);
  });
});

describe("SUMMARY_TABS —— 右侧面板是四个 tab", () => {
  it("四个 tab，键名与上位一致", () => {
    expect(SUMMARY_TABS.map((t) => t.label)).toEqual(["产物", "浏览器", "图片与视频", "子智能体"]);
    expect(SUMMARY_TABS.map((t) => t.key)).toEqual([
      "sidePanel_summary_tab_artifacts",
      "sidePanel_summary_tab_browser",
      "sidePanel_summary_tab_media",
      "sidePanel_summary_tab_subtasks",
    ]);
  });
});

describe("其它实测文案", () => {
  it("首页问候与输入区占位符", () => {
    expect(HOME_GREETING).toBe("今天有什么工作要处理?");
    expect(COMPOSER_PLACEHOLDER).toContain("发消息或创建任务");
    expect(COMPOSER_PLACEHOLDER).toContain("@ 引用");
    expect(COMPOSER_PLACEHOLDER).toContain("/ 命令");
    expect(SCHEDULE_COMPOSER_PLACEHOLDER).toBe("给 Ding Harness 安排任务");
  });

  it("标题口径与生成中文案", () => {
    expect(TASK_TITLE_LIMIT).toBe(16);
    expect(ARTIFACT_TITLE_GENERATING).toBe("标题生成中...");
  });
});

describe("pickSuggestions —— 首页推荐卡要真的会变", () => {
  it("抽够条数", () => {
    expect(pickSuggestions(["a", "b", "c", "d", "e"], 4)).toHaveLength(4);
  });

  it("**不重复**（同一批里出现两条一样的，一眼就看出来是 bug）", () => {
    const picked = pickSuggestions(["a", "b", "c", "d", "e", "f"], 4, () => 0);
    expect(new Set(picked).size).toBe(picked.length);
  });

  it("**随机序列不同 → 组合不同**（否则「会变」是假的）", () => {
    const pool = ["a", "b", "c", "d", "e"];
    const first = pickSuggestions(pool, 3, () => 0);
    let calls = 0;
    const second = pickSuggestions(pool, 3, () => (calls++ === 0 ? 0.9 : 0.1));
    expect(first).not.toEqual(second);
  });

  it("池子比要的条数少时，给多少算多少（不能死循环）", () => {
    // 用集合而不是数组比：函数**不承诺顺序**（每次是随机的），断言顺序会变成随机失败
    const picked = pickSuggestions(["a", "b"], 4, () => 0);
    expect(picked).toHaveLength(2);
    expect(new Set(picked)).toEqual(new Set(["a", "b"]));
  });

  it("随机值取 1 也不越界（夹具不该依赖 Math.random 是半开的）", () => {
    expect(pickSuggestions(["a", "b", "c"], 3, () => 1)).toHaveLength(3);
  });

  it("池子必须比展示条数大 —— 写死四条会露馅", () => {
    expect(SUGGESTION_POOL.length).toBeGreaterThan(SUGGESTION_COUNT);
  });

  it("池子里没有重复项", () => {
    expect(new Set(SUGGESTION_POOL).size).toBe(SUGGESTION_POOL.length);
  });

  it("每条都是「工具 + 要点」形态（实机如此：前半句能力，后半句这次干什么）", () => {
    for (const item of SUGGESTION_POOL) {
      expect(item.includes(" ")).toBe(true);
      expect(item.length).toBeLessThan(40);
    }
  });
});

/* ============================================================
 * 首页工作模式（D02，2026-10-18）
 *
 * 首屏先选「编码 / 办公」，推荐卡跟着模式走。这组断言挡两件事：
 * ① 两个池子不能混（编码模式里出现 PPT 卡 = 没接上）；
 * ② 编码池的每一条同样要能拆出「类目 + 指令」（否则图标与对齐会错）。
 * ============================================================ */
describe("首页工作模式（D02）", () => {
  it("两种模式、顺序是 编码 → 办公", () => {
    expect(HOME_MODES.map((m) => m.id)).toEqual(["coding", "office"]);
    expect(HOME_MODES.map((m) => m.label)).toEqual(["编码", "办公"]);
  });

  it("⭐ 推荐卡真的跟着模式走（两个池子不混）", () => {
    expect(suggestionsFor("coding")).toBe(CODING_SUGGESTION_POOL);
    expect(suggestionsFor("office")).toBe(SUGGESTION_POOL);
    // 编码池里不该出现办公类目 —— 那正是"没接上"的样子
    for (const raw of suggestionsFor("coding")) {
      expect(raw, `编码模式里混进了办公卡「${raw}」`).not.toMatch(/PPT|Word|Excel|云文档/);
    }
  });

  it("磁盘读到的值不可信：只认 coding，其余一律 office", () => {
    expect(parseHomeMode("coding")).toBe("coding");
    expect(parseHomeMode("office")).toBe("office");
    expect(parseHomeMode("CODING")).toBe("office");
    expect(parseHomeMode(undefined)).toBe("office");
    expect(parseHomeMode(42)).toBe("office");
  });

  it("首屏标题两种模式不同（否则切换看不出变化）", () => {
    expect(HOME_TITLE.coding).not.toBe(HOME_TITLE.office);
    expect(HOME_TITLE.office).toBe(HOME_GREETING);
  });

  it("编码池每条都能拆出非空的类目与指令，且池子够大", () => {
    expect(CODING_SUGGESTION_POOL.length).toBeGreaterThan(SUGGESTION_COUNT);
    expect(new Set(CODING_SUGGESTION_POOL).size).toBe(CODING_SUGGESTION_POOL.length);
    for (const raw of CODING_SUGGESTION_POOL) {
      const { tag, text } = splitSuggestion(raw);
      expect(tag.length, `「${raw}」缺类目`).toBeGreaterThan(0);
      expect(text.length, `「${raw}」缺指令`).toBeGreaterThan(0);
      expect(tag.includes(" "), `「${raw}」的类目里有空格`).toBe(false);
    }
  });

  it("持久化键带项目前缀（与画布那批一起可清理）", () => {
    expect(HOME_MODE_KEY.startsWith("dsh-canvas.")).toBe(true);
  });
});

/* ============================================================
 * 推荐卡的「类目 / 指令」拆分（§139）
 *
 * 形态依据本体首页实机截图：每张卡是「类目图标 + 类目 + 指令」。
 * ============================================================ */
describe("splitSuggestion —— 推荐卡的类目与指令", () => {
  it("按**第一个空格**切（指令里还能有空格，别切错）", () => {
    expect(splitSuggestion("云文档 把这份长文档压缩一下")).toEqual({
      tag: "云文档",
      text: "把这份长文档压缩一下",
    });
    // 指令里既有空格又有「PDF」这个词 —— 只有第一个空格才是分隔
    expect(splitSuggestion("PDF 帮我把 PDF 文档转成 Word")).toEqual({
      tag: "PDF",
      text: "帮我把 PDF 文档转成 Word",
    });
  });

  it("没有空格时整条当类目、指令为空（不抛错）", () => {
    expect(splitSuggestion("就一个词")).toEqual({ tag: "就一个词", text: "" });
  });

  it("⭐ 池子里每一条都必须能拆出**非空的类目与指令**", () => {
    for (const raw of SUGGESTION_POOL) {
      const { tag, text } = splitSuggestion(raw);
      expect(tag.length, `「${raw}」缺类目`).toBeGreaterThan(0);
      expect(text.length, `「${raw}」缺指令`).toBeGreaterThan(0);
      // 类目里不该有空格（有的话说明这条写错了分隔位置）
      expect(tag.includes(" "), `「${raw}」的类目里有空格`).toBe(false);
    }
  });

  it("⭐ 保真锁定：从本体实时文本转储抄下来的那四条，必须在池子里且一字不差", () => {
    /*
     * 来源：app-triage/dynamic-ui/live-text.txt（本体首页的实时文本，顺序即实机顺序）。  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
     * 这四条是**观察到的**，不是我自己编的类目 —— 顺手改掉就等于把"照抄"改回"我设计"。
     */
    const observed = [
      "云文档 把这份长文档压缩一下",
      "PDF 帮我把 PDF 文档转成 Word",
      "VOC与舆情调研 帮我监控一下品牌的社媒口碑",
      "PPT 帮我把一堆资料做成 PPT",
    ];
    for (const line of observed) {
      expect(SUGGESTION_POOL as readonly string[], `池子里少了「${line}」`).toContain(line);
    }
  });
});
