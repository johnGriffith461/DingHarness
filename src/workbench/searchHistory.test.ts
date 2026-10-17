import { describe, expect, it } from "vitest";
import {
  HISTORY_LIMIT,
  HISTORY_MIN_LEN,
  SEARCH_HISTORY_LABELS,
  emptyHistory,
  hasHistory,
  normalizeHistory,
  pushHistory,
  removeHistory,
  scopeLabel,
} from "@shared/searchHistory";

/**
 * 搜索历史（§162）。
 *
 * 断言对着 `docs/evidence-search.txt` 与 `docs/evidence-drive.txt`：  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 * `search_history`（全部搜索记录）/ `search_history_clear`（清空全部搜索记录）
 * / `drive_search_history_sectionHeader`（搜索历史）。
 */
describe("文案与本体对齐（逐字取自证据）", () => {
  it("那四句", () => {
    expect(SEARCH_HISTORY_LABELS.section).toBe("搜索历史");
    expect(SEARCH_HISTORY_LABELS.all).toBe("全部搜索记录");
    expect(SEARCH_HISTORY_LABELS.clearAll).toBe("清空全部搜索记录");
    expect(SEARCH_HISTORY_LABELS.clear).toBe("清空");
  });

  it("范围的中文名", () => {
    expect(scopeLabel("skills")).toBe("技能");
    expect(scopeLabel("files")).toBe("云盘");
  });
});

describe("pushHistory", () => {
  it("新词排最前", () => {
    expect(pushHistory(["旧的"], "新的")).toEqual(["新的", "旧的"]);
  });

  it("⭐ 同一个词再搜一次：挪到最前，**不重复一条**", () => {
    expect(pushHistory(["a词", "b词"], "b词")).toEqual(["b词", "a词"]);
  });

  it("⭐ 判重不区分大小写（Report 与 report 是同一个词）", () => {
    expect(pushHistory(["Report"], "report")).toEqual(["report"]);
  });

  it("空格词不记（搜过等于没搜）", () => {
    expect(pushHistory(["x词"], "   ")).toEqual(["x词"]);
  });

  it("太短的词不记（阈值是个明确的数）", () => {
    expect(HISTORY_MIN_LEN).toBe(2);
    expect(pushHistory([], "看")).toEqual([]);
    expect(pushHistory([], "看板")).toEqual(["看板"]);
  });

  it("超过上限砍最旧的", () => {
    let list: string[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 3; i += 1) list = pushHistory(list, `词${i}`);
    expect(list).toHaveLength(HISTORY_LIMIT);
    expect(list[0]).toBe(`词${HISTORY_LIMIT + 2}`);
  });

  it("去掉首尾空白再存", () => {
    expect(pushHistory([], "  看板  ")).toEqual(["看板"]);
  });

  it("不改原数组", () => {
    const src = ["a词"];
    pushHistory(src, "b词");
    expect(src).toEqual(["a词"]);
  });
});

describe("removeHistory", () => {
  it("按内容去掉一条（大小写不敏感）", () => {
    expect(removeHistory(["Report", "看板"], "report")).toEqual(["看板"]);
  });

  it("去不存在的词时原样返回", () => {
    expect(removeHistory(["看板"], "别的")).toEqual(["看板"]);
  });
});

describe("normalizeHistory（磁盘不可信）", () => {
  it("两个范围都读回来", () => {
    const got = normalizeHistory({ skills: ["解释代码"], files: ["看板"] });
    expect(got.skills).toEqual(["解释代码"]);
    expect(got.files).toEqual(["看板"]);
  });

  it("坏数据丢掉、好数据保住", () => {
    const got = normalizeHistory({ skills: ["好词", 42, null, "  ", "看"], files: "不是数组" });
    expect(got.skills).toEqual(["好词"]);
    expect(got.files).toEqual([]);
  });

  it("⭐ 读回来也要去重（文件可能被人手改过）", () => {
    expect(normalizeHistory({ skills: ["看板", "看板", "KAN"] }).skills).toEqual(["看板", "KAN"]);
  });

  it("⭐ 读回来也要截上限（不然文件能无限涨）", () => {
    const many = Array.from({ length: 50 }, (_, i) => `词${i}`);
    expect(normalizeHistory({ files: many }).files).toHaveLength(HISTORY_LIMIT);
  });

  it("不是对象就给两个空数组", () => {
    expect(normalizeHistory(null)).toEqual(emptyHistory());
    expect(normalizeHistory("x").skills).toEqual([]);
  });

  it("空历史是**三个空数组**（不是 undefined —— 界面会直接 .map）", () => {
    const empty = emptyHistory();
    expect(Array.isArray(empty.skills)).toBe(true);
    expect(Array.isArray(empty.files)).toBe(true);
    expect(Array.isArray(empty.sessions)).toBe(true);
  });
});

describe("hasHistory", () => {
  it("有才显示那一段", () => {
    expect(hasHistory({ skills: ["看板"], files: [], sessions: [] }, "skills")).toBe(true);
    expect(hasHistory({ skills: ["看板"], files: [], sessions: [] }, "files")).toBe(false);
    expect(hasHistory({ skills: [], files: [], sessions: ["报错"] }, "sessions")).toBe(true);
  });
});
