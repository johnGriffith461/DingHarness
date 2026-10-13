import { describe, expect, it } from "vitest";
import {
  PHRASES,
  PHRASE_LABELS,
  applyPhrase,
  detectAtTrigger,
  filterPhrases,
  phraseGroups,
} from "@shared/phrases";

/**
 * `@` 常用语（§161）。
 *
 * 证据只有一条逐字的（`coding_chat_mode_new_placeholder`：
 * 输入"@"唤起常用语，或粘贴代码快速提问）—— 它定的是**触发方式**。
 * **词条内容是本机自定的**（本体那份在服务端），所以下面测的是"触发与替换对不对"，
 * 而不是"词条跟原版一样"。
 */
describe("文案（触发方式那句逐字取自证据）", () => {
  it("触发提示逐字", () => {
    expect(PHRASE_LABELS.triggerHint).toBe('输入"@"唤起常用语，或粘贴代码快速提问');
  });

  it("选单标题与空态（空态是自定措辞，证据里没有）", () => {
    expect(PHRASE_LABELS.title).toBe("常用语");
    expect(PHRASE_LABELS.empty).toBe("没有匹配的常用语");
  });
});

describe("词库本身", () => {
  it("id 唯一（选单靠它定位）", () => {
    const ids = PHRASES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("⭐ 每条都能**直接开工** —— 不是「帮我看看」那种说了等于没说的", () => {
    for (const p of PHRASES) {
      expect(p.title.length).toBeGreaterThan(1);
      expect(p.text.length).toBeGreaterThan(8);
    }
  });

  it("分组是有序去重的", () => {
    const groups = phraseGroups();
    expect(new Set(groups).size).toBe(groups.length);
    expect(groups).toContain("读代码");
  });
});

describe("detectAtTrigger", () => {
  it("刚敲一个 @ 就触发", () => {
    expect(detectAtTrigger("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("@ 后面带字：query 就是那几个字", () => {
    expect(detectAtTrigger("@解释", 3)).toEqual({ start: 0, end: 3, query: "解释" });
  });

  it("⭐ 句中的 @ 不触发（邮箱一敲 @ 就弹选单最烦人）", () => {
    expect(detectAtTrigger("a@b.com", 7)).toBeNull();
  });

  it("⭐ 前面有字但没空白也不触发", () => {
    expect(detectAtTrigger("看这个@", 4)).toBeNull();
  });

  it("前一个字是空格 → 触发（正常写法）", () => {
    const t = "帮我看看 @解释";
    expect(detectAtTrigger(t, t.length)?.query).toBe("解释");
  });

  it("⭐ @ 与光标之间有空白 → 不触发（选单该收了）", () => {
    expect(detectAtTrigger("@ 空格了", 5)).toBeNull();
  });

  it("光标在 @ 前面时不触发", () => {
    expect(detectAtTrigger("x @y", 1)).toBeNull();
  });

  it("完全没有 @ 时不触发", () => {
    expect(detectAtTrigger("普通一句话", 5)).toBeNull();
  });

  it("取最近的那个 @（前面还有别的 @ 也算）", () => {
    const t = "@旧的 @新";
    expect(detectAtTrigger(t, t.length)?.start).toBe(4);
  });

  it("越界光标不炸", () => {
    expect(detectAtTrigger("@", 99)?.query).toBe("");
    expect(detectAtTrigger("", -5)).toBeNull();
  });
});

describe("filterPhrases", () => {
  it("空查询给全量（新数组）", () => {
    const got = filterPhrases("");
    expect(got).toHaveLength(PHRASES.length);
    expect(got).not.toBe(PHRASES);
  });

  it("按标题筛", () => {
    expect(filterPhrases("bug").map((p) => p.id)).toEqual(["find-bug"]);
  });

  it("按正文筛（记不住标题时也能搜到）", () => {
    expect(filterPhrases("单元测试").map((p) => p.id)).toContain("add-tests");
  });

  it("搜不到给空数组（界面说「没有匹配的常用语」）", () => {
    expect(filterPhrases("zzz")).toEqual([]);
  });
});

describe("applyPhrase", () => {
  const bug = PHRASES.find((p) => p.id === "find-bug")!;

  it("把 `@查询词` 整段换掉", () => {
    const t = "帮我看看 @找";
    const got = applyPhrase(t, { start: 5, end: t.length, query: "找" }, bug);
    expect(got.text.startsWith("帮我看看 ")).toBe(true);
    expect(got.text).toContain("潜在 bug");
    expect(got.text).not.toContain("@");
  });

  it("⭐ 光标落在插入内容的末尾（用户接着就能写/粘代码）", () => {
    const t = "@x";
    const got = applyPhrase(t, { start: 0, end: 2, query: "x" }, bug);
    expect(got.caret).toBe(bug.text.length);
  });

  it("@ 后面的原有文字不被吃掉（只替换触发词那一段）", () => {
    const t = "@找 这后面的字要留着";
    // 触发词是 "@找"（start=0, end=2），后面的 " 这后面的字要留着" 不属于触发词
    const got = applyPhrase(t, { start: 0, end: 2, query: "找" }, bug);
    expect(got.text.endsWith(" 这后面的字要留着")).toBe(true);
  });

  it("前面有内容时，替换后前面的内容原样保留", () => {
    const t = "前缀 @";
    const got = applyPhrase(t, { start: 3, end: 4, query: "" }, bug);
    expect(got.text.startsWith("前缀 ")).toBe(true);
  });

  it("没有触发（空文本）也不崩", () => {
    const got = applyPhrase("", { start: 0, end: 0, query: "" }, bug);
    expect(got.text).toBe(bug.text);
  });
});
