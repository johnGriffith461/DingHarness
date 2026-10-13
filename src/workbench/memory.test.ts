import { describe, expect, it } from "vitest";

import {
  addMemory,
  clearMemory,
  EMPTY_MEMORY,
  MEMORY_BLOCK_CHARS,
  MEMORY_MAX,
  MEMORY_TEXT_LIMIT,
  memoryPromptBlock,
  normalizeMemory,
  removeMemory,
  type MemoryLib,
} from "../../shared/memory";

/**
 * 记忆的模型行为。
 *
 * 这是本项目第 3 个"存到磁盘再读回来"的模型（前两个是 library 与 schedule），
 * 所以重点同样放在**脏数据容错**与**往返稳定**上 —— §49 那次
 * "加完能用、重启就没了"就是漏了这层。
 */

/** 造一个合法条目。 */
function entry(id: string, text: string, createdAt = "2026-01-01T00:00:00.000Z") {
  return { id, text, createdAt, source: "manual" as const };
}

describe("记忆：规整脏数据", () => {
  it("非对象 / 非数组一律给空库，不抛", () => {
    for (const raw of [null, undefined, 42, "x", {}, { entries: "no" }]) {
      expect(normalizeMemory(raw)).toEqual({ entries: [] });
    }
  });

  it("缺 id 或缺正文的条目被丢掉", () => {
    const got = normalizeMemory({ entries: [entry("a", "有效"), { id: "", text: "无 id" }, { id: "b", text: "  " }] });
    expect(got.entries.map((e) => e.id)).toEqual(["a"]);
  });

  it("同 id 只留第一条", () => {
    const got = normalizeMemory({ entries: [entry("a", "第一次"), entry("a", "第二次")] });
    expect(got.entries).toHaveLength(1);
    expect(got.entries[0].text).toBe("第一次");
  });

  it("超长正文被截断到上限", () => {
    const got = normalizeMemory({ entries: [entry("a", "字".repeat(MEMORY_TEXT_LIMIT + 50))] });
    expect(got.entries[0].text).toHaveLength(MEMORY_TEXT_LIMIT);
  });

  it("条数超过上限时截断", () => {
    const many = Array.from({ length: MEMORY_MAX + 20 }, (_, i) => entry(`id${i}`, `第 ${i} 条`));
    expect(normalizeMemory({ entries: many }).entries).toHaveLength(MEMORY_MAX);
  });

  it("按创建时间倒序（新的在前）", () => {
    const got = normalizeMemory({
      entries: [entry("old", "旧", "2026-01-01T00:00:00Z"), entry("new", "新", "2026-05-01T00:00:00Z")],
    });
    expect(got.entries.map((e) => e.id)).toEqual(["new", "old"]);
  });

  it("来源只有 manual / conversation 两种，其余归 manual", () => {
    const got = normalizeMemory({ entries: [{ id: "a", text: "x", source: "猜测" }] });
    expect(got.entries[0].source).toBe("manual");
  });
});

describe("记忆：增删清", () => {
  it("加一条后新的在前", () => {
    const lib = addMemory(addMemory(EMPTY_MEMORY, "第一"), "第二");
    expect(lib.entries.map((e) => e.text)).toEqual(["第二", "第一"]);
  });

  it("空白正文不产生条目", () => {
    expect(addMemory(EMPTY_MEMORY, "   ").entries).toHaveLength(0);
  });

  it("同一条正文不重复添加（手动加与从对话存常会撞）", () => {
    const once = addMemory(EMPTY_MEMORY, "我喜欢简短回答");
    const twice = addMemory(once, "我喜欢简短回答");
    expect(twice.entries).toHaveLength(1);
  });

  it("不改原对象（纯函数）", () => {
    const before = [...EMPTY_MEMORY.entries];
    addMemory(EMPTY_MEMORY, "x");
    expect(EMPTY_MEMORY.entries).toEqual(before);
  });

  it("删一条不影响其余", () => {
    const lib: MemoryLib = { entries: [entry("a", "甲"), entry("b", "乙")] };
    expect(removeMemory(lib, "a").entries.map((e) => e.id)).toEqual(["b"]);
  });

  it("删不存在的 id 是空操作", () => {
    const lib: MemoryLib = { entries: [entry("a", "甲")] };
    expect(removeMemory(lib, "zzz")).toEqual(lib);
  });

  it("清除返回空库", () => {
    expect(clearMemory()).toEqual({ entries: [] });
  });

  it("往返稳定：规整过的库再规整一次不变", () => {
    const lib = addMemory(addMemory(EMPTY_MEMORY, "甲"), "乙");
    const once = normalizeMemory(lib);
    expect(normalizeMemory(once)).toEqual(once);
  });
});

describe("记忆：注入系统提示词", () => {
  it("空库给空串（拼进去不会多出空行）", () => {
    expect(memoryPromptBlock(EMPTY_MEMORY)).toBe("");
  });

  it("每条一行，带标题", () => {
    const lib = addMemory(addMemory(EMPTY_MEMORY, "甲"), "乙");
    const block = memoryPromptBlock(lib);
    expect(block).toContain("【长期记忆】");
    expect(block).toContain("- 乙");
    expect(block).toContain("- 甲");
  });
});


describe("记忆注入的字数上限（§164）", () => {
  /** 造 n 条长度固定的记忆（新的在前，与 MemoryLib 的约定一致）。 */
  const withEntries = (n: number, chars = 40) => {
    let lib = EMPTY_MEMORY;
    for (let i = 0; i < n; i += 1) lib = addMemory(lib, `记忆${i}-${"字".repeat(chars)}`);
    return lib;
  };

  it("上限是个明确的数（这一块每轮都要塞进系统提示词）", () => {
    expect(MEMORY_BLOCK_CHARS).toBe(1500);
  });

  it("⭐ 条目多到爆上限时，注入的那块**不超过上限**（留点余量给「未展开」那句）", () => {
    const block = memoryPromptBlock(withEntries(100));
    expect(block.length).toBeLessThan(MEMORY_BLOCK_CHARS + 200);
  });

  it("⭐ 超了要**如实说还有几条没展开**（静默截断会让模型以为没这回事）", () => {
    const block = memoryPromptBlock(withEntries(100));
    expect(block).toContain("未展开");
    expect(block).toMatch(/另有 \d+ 条记忆未展开/);
  });

  it("没超上限时**不出现**那句（不无中生有）", () => {
    const block = memoryPromptBlock(withEntries(3), 5000);
    expect(block).not.toContain("未展开");
  });

  it("⭐ 先展开**最近记的**（条目新的在前，截断要从旧的开始丢）", () => {
    // 只够放一条时，应该在的是最后加进去的那条（i 最大的 = 最新的）
    const lib = withEntries(5, 20);
    const block = memoryPromptBlock(lib, 60);
    const newest = lib.entries[0]!.text;
    expect(block).toContain(newest);
  });

  it("⭐ 哪怕一条都放不下，也**至少给一条**（一条不给比多占点字更糟）", () => {
    const lib = withEntries(3, 300);
    const block = memoryPromptBlock(lib, 10);
    expect(block).toContain("- ");
    expect(block.split("\n").filter((l) => l.startsWith("- ")).length).toBeGreaterThanOrEqual(1);
  });

  it("上限是参数化传的（不必改常量就能测边界）", () => {
    const block = memoryPromptBlock(withEntries(10, 10), 200);
    expect(block.length).toBeLessThan(400);
  });

  it("空库仍然是空串（两种上限都不改变这条）", () => {
    expect(memoryPromptBlock(EMPTY_MEMORY, 10)).toBe("");
  });
});

describe("记忆开关（§182）", () => {
  const lib: MemoryLib = {
    entries: [{ id: "m1", text: "我叫阿岩", createdAt: "2026-01-01T00:00:00.000Z", source: "manual" }],
  };

  it("⭐ 关掉记忆 → **不注入**（这是那个开关唯一的真效果）", () => {
    expect(memoryPromptBlock({ ...lib, enabled: false })).toBe("");
  });

  it("开着（或没这个字段）→ 照常注入", () => {
    expect(memoryPromptBlock({ ...lib, enabled: true })).toContain("阿岩");
    expect(memoryPromptBlock(lib)).toContain("阿岩");
  });

  it("⭐ 关掉不是删掉：条目还在，开回来照样在（`normalizeMemory` 也不许把开关弄丢）", () => {
    const off = normalizeMemory({ entries: lib.entries, enabled: false });
    expect(off.entries).toHaveLength(1);
    expect(off.enabled).toBe(false);
    // 开回来之后内容还在
    expect(memoryPromptBlock({ ...off, enabled: true })).toContain("阿岩");
  });

  it("⭐ 开关状态要活过重启：落盘再读回来还是关着", () => {
    expect(normalizeMemory({ entries: [], enabled: false }).enabled).toBe(false);
    expect(normalizeMemory({ entries: [], enabled: true }).enabled).toBeUndefined();
  });

  it("坏文件（不是对象）当成开着（默认不该是「悄悄停掉记忆」）", () => {
    expect(normalizeMemory(null).enabled).toBeUndefined();
    expect(memoryPromptBlock(normalizeMemory(null))).toBe("");
  });
});
