import { describe, expect, it } from "vitest";

import {
  addMemory,
  clearMemory,
  EMPTY_MEMORY,
  MEMORY_BLOCK_CHARS,
  MEMORY_MAX,
  MEMORY_TEXT_LIMIT,
  LOCAL_MEMORY_OWNER,
  MEMORY_DOMAINS,
  memoryVisibleTo,
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

/**
 * 记忆归属域（C4，V5-1 3.8）。
 *
 * 两条要挡的事：① 旧记忆（没有域这一格）必须按最保守的域读 —— private；
 * ② **别人的 private 记忆不许进我的提示词**（跨域不可读的注入侧那一半）。
 */
describe("C4：记忆归属域（private / team）", () => {
  const entry = (over: Partial<Parameters<typeof normalizeMemory>[0] extends never ? never : Record<string, unknown>> = {}) => ({
    id: "m1",
    text: "记一句",
    createdAt: "2026-10-17T00:00:00.000Z",
    source: "manual" as const,
    ...over,
  });

  it("两级就这两个（枚举，不是自由的字符串）", () => {
    expect(MEMORY_DOMAINS).toEqual(["private", "team"]);
  });

  it("⭐ 旧记忆（没有域/没有归属）→ private + 本机用户（兼容矩阵口径，最保守的域）", () => {
    const lib = normalizeMemory({ entries: [entry()] });
    expect(lib.entries[0]?.domain).toBe("private");
    expect(lib.entries[0]?.owner).toBe(LOCAL_MEMORY_OWNER);
  });

  it("坏值收窄：不认识的域落 private；空/非字符串归属落本机用户；归属两端空白去掉", () => {
    const lib = normalizeMemory({
      entries: [
        entry({ id: "a", domain: "宇宙" }),
        entry({ id: "b", owner: "   " }),
        entry({ id: "c", owner: 42 }),
        entry({ id: "d", owner: "  u-bob  " }),
      ],
    });
    const byId = new Map(lib.entries.map((e) => [e.id, e]));
    expect(byId.get("a")?.domain).toBe("private");
    expect(byId.get("b")?.owner).toBe(LOCAL_MEMORY_OWNER);
    expect(byId.get("c")?.owner).toBe(LOCAL_MEMORY_OWNER);
    expect(byId.get("d")?.owner).toBe("u-bob");
  });

  it("团队域原样保留（它不看归属那一格）", () => {
    const lib = normalizeMemory({ entries: [entry({ domain: "team", owner: "u-bob" })] });
    expect(lib.entries[0]?.domain).toBe("team");
  });

  it("⭐ 可见性：team 谁都能看；private 只给它的主人", () => {
    const mine = { ...entry({ id: "mine" }), domain: "private" as const, owner: "u-alice" };
    const theirs = { ...entry({ id: "theirs" }), domain: "private" as const, owner: "u-bob" };
    const shared = { ...entry({ id: "shared" }), domain: "team" as const, owner: "u-bob" };
    expect(memoryVisibleTo(mine, "u-alice")).toBe(true);
    expect(memoryVisibleTo(mine, "u-bob")).toBe(false);
    expect(memoryVisibleTo(theirs, "u-alice")).toBe(false);
    expect(memoryVisibleTo(shared, "u-alice")).toBe(true);
    expect(memoryVisibleTo(shared, "u-carol")).toBe(true);
  });

  it("⭐ 注入侧：别人的 private 一行都不进提示词；team 与自己的 private 在", () => {
    const lib: MemoryLib = {
      entries: [
        { ...entry({ id: "a", text: "我自己的私事" }), domain: "private", owner: "u-alice" },
        { ...entry({ id: "b", text: "别人的私事" }), domain: "private", owner: "u-bob" },
        { ...entry({ id: "c", text: "团队都知道的事" }), domain: "team", owner: "u-bob" },
      ],
    };
    const block = memoryPromptBlock(lib, MEMORY_BLOCK_CHARS, "u-alice");
    expect(block).toContain("我自己的私事");
    expect(block).toContain("团队都知道的事");
    expect(block, "别人的 private 记忆进了我的提示词").not.toContain("别人的私事");
    /* 换个人看：看到的是另一批（同一份库里没有"谁都能看全部"这条路） */
    const bob = memoryPromptBlock(lib, MEMORY_BLOCK_CHARS, "u-bob");
    expect(bob).toContain("别人的私事");
    expect(bob).not.toContain("我自己的私事");
  });

  it("本机单用户（缺省 viewer = local）：与从前逐字相同（老路径零变化）", () => {
    const lib = normalizeMemory({ entries: [entry({ text: "老记忆" })] });
    const withDefault = memoryPromptBlock(lib);
    const withExplicit = memoryPromptBlock(lib, MEMORY_BLOCK_CHARS, LOCAL_MEMORY_OWNER);
    expect(withDefault).toBe(withExplicit);
    expect(withDefault).toContain("老记忆");
  });

  it("addMemory：新记忆缺省 private + 本机用户；可以指定 team/别人（将来团队空间用）", () => {
    const added = addMemory(EMPTY_MEMORY, "记一句");
    expect(added.entries[0]?.domain).toBe("private");
    expect(added.entries[0]?.owner).toBe(LOCAL_MEMORY_OWNER);
    const team = addMemory(EMPTY_MEMORY, "团队的事", { domain: "team", owner: "u-alice" });
    expect(team.entries[0]?.domain).toBe("team");
    expect(team.entries[0]?.owner).toBe("u-alice");
  });
});
