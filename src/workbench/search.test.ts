import { describe, expect, it } from "vitest";
import {
  SEARCH_LABELS,
  emptyLabelFor,
  matchRank,
  matchesAll,
  placeholderFor,
  searchItems,
  tokensOf,
} from "@shared/search";

/**
 * 搜索（§160）。
 *
 * 断言对着 `docs/evidence-search.txt`（`search_*`）与 `docs/evidence-drive.txt`
 * （`drive_searchWindow_*` 那一组）—— 两处搜索**共用同一条匹配口径**。
 */
describe("文案与本体对齐（逐字取自证据）", () => {
  it("两处的占位与空态", () => {
    expect(SEARCH_LABELS.skills).toBe("搜索技能");
    expect(SEARCH_LABELS.skillsEmpty).toBe("无匹配的技能");
    expect(SEARCH_LABELS.files).toBe("搜索文件");
    expect(SEARCH_LABELS.filesEmpty).toBe("未搜索到匹配的文件");
  });

  it("云盘搜索的标题与「暂无搜索结果」", () => {
    expect(SEARCH_LABELS.filesTitle).toBe("云盘搜索");
    expect(SEARCH_LABELS.noResult).toBe("暂无搜索结果");
  });

  it("搜索历史那两句（记下来，本机版还没做）", () => {
    expect(SEARCH_LABELS.history).toBe("全部搜索记录");
    expect(SEARCH_LABELS.historyClear).toBe("清空全部搜索记录");
  });

  it("占位按范围给对应那句", () => {
    expect(placeholderFor("skills")).toBe("搜索技能");
    expect(placeholderFor("files")).toBe("搜索文件");
  });
});

describe("tokensOf（空格分词，多词是 AND）", () => {
  it("空格切成多个词", () => {
    expect(tokensOf("销售 看板")).toEqual(["销售", "看板"]);
  });

  it("大小写不敏感 + 去重", () => {
    expect(tokensOf("A a B")).toEqual(["a", "b"]);
  });

  it("空输入给空表（空表 = 不筛）", () => {
    expect(tokensOf("   ")).toEqual([]);
  });

  it("多个空格不产生空词", () => {
    expect(tokensOf("a   b")).toEqual(["a", "b"]);
  });
});

describe("matchesAll（AND 语义）", () => {
  it("空词表恒真 —— 「没输就全给」", () => {
    expect(matchesAll("任何东西", [])).toBe(true);
  });

  it("⭐ 多词全中才算命中", () => {
    expect(matchesAll("销售数据看板", ["销售", "看板"])).toBe(true);
    expect(matchesAll("销售数据表", ["销售", "看板"])).toBe(false);
  });

  it("子串命中，大小写不敏感", () => {
    expect(matchesAll("Report.PDF", ["report"])).toBe(true);
  });
});

describe("matchRank（不只是筛，还要会排）", () => {
  it("完全相等最高", () => {
    expect(matchRank("看板", ["看板"])).toBe(3);
  });

  it("以词开头次之", () => {
    expect(matchRank("看板-2024", ["看板"])).toBe(2);
  });

  it("只是包含最低", () => {
    expect(matchRank("销售数据看板", ["看板"])).toBe(1);
  });

  it("不命中是 0", () => {
    expect(matchRank("别的", ["看板"])).toBe(0);
  });

  it("空词表给 1（不筛的时候就别排序了）", () => {
    expect(matchRank("随便", [])).toBe(1);
  });
});

describe("searchItems", () => {
  const list = ["销售数据看板", "看板", "看板娘工具", "会议纪要"];

  it("⭐ 命中程度高的排前面（只筛不排的话顺序取决于文件系统，用户会觉得搜不准）", () => {
    expect(searchItems(list, "看板", (x) => x)).toEqual(["看板", "看板娘工具", "销售数据看板"]);
  });

  it("空查询原样返回（新数组）", () => {
    const got = searchItems(list, "", (x) => x);
    expect(got).toEqual(list);
    expect(got).not.toBe(list);
  });

  it("全不命中给空数组", () => {
    expect(searchItems(list, "不存在", (x) => x)).toEqual([]);
  });

  it("同分按名字稳定排序（否则顺序每次渲染都可能变）", () => {
    const same = ["b-看板", "a-看板", "c-看板"];
    expect(searchItems(same, "看板", (x) => x)).toEqual(["a-看板", "b-看板", "c-看板"]);
  });

  it("取名字的函数可以是别的字段", () => {
    const objs = [{ id: "1", title: "甲" }, { id: "2", title: "乙" }];
    expect(searchItems(objs, "乙", (x) => x.title).map((x) => x.id)).toEqual(["2"]);
  });

  it("不改原数组", () => {
    const src = ["销售数据看板", "看板"];
    searchItems(src, "看板", (x) => x);
    expect(src).toEqual(["销售数据看板", "看板"]);
  });
});

describe("emptyLabelFor", () => {
  it("有结果时不用说话", () => {
    expect(emptyLabelFor("skills", 3)).toBe("");
    expect(emptyLabelFor("files", 1)).toBe("");
  });

  it("没结果时按范围说对应那句", () => {
    expect(emptyLabelFor("skills", 0)).toBe("无匹配的技能");
    expect(emptyLabelFor("files", 0)).toBe("未搜索到匹配的文件");
  });
});
