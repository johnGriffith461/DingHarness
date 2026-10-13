import { describe, expect, it } from "vitest";
import {
  addCustom,
  EMPTY_LIBRARY,
  normalizeLibrary,
  toggleEnabled,
  toggleInstalled,
  type Library,
} from "@shared/library";

/**
 * 库的**往返不变量**：存盘 → 载入之后，装/启用状态不能凭空消失。
 *
 * ## 为什么要单独写这一类
 * §49 那个 bug（自定义能力重启就没了）**前面所有断言在当次会话里都是通过的** ——
 * 落盘对、chip 对、选择器对。它只在"下次载入"时暴露。
 *
 * 而它的形状是通用的：**`normalizeLibrary` 拿静态集合去剔 id，而那个 id 其实是动态来的**。
 * 只要有新的动态 id 来源（自定义能力、将来的别的），同样的错还会再犯一次。
 *
 * 所以这里不写"自定义能力能不能存下来"这种具体案例，
 * 而是写**不变量**：*凡是装上了/启用了的条目，往返之后必须还在。*
 * 案例会过时，不变量不会。
 */

/** 模拟一次"存盘 → 载入"。 */
const roundTrip = (lib: Library, catalogIds: Set<string>, taskIds: Set<string> | null = null): Library =>
  normalizeLibrary(JSON.parse(JSON.stringify(lib)), catalogIds, taskIds);

const CATALOG = new Set(["builtin-1", "builtin-2"]);

describe("往返不变量：装/启用状态不能凭空消失", () => {
  it("内置目录条目：往返后装/启用都还在", () => {
    let lib = toggleEnabled(toggleInstalled(EMPTY_LIBRARY, "builtin-1"), "builtin-1");
    lib = toggleInstalled(lib, "builtin-2");
    const back = roundTrip(lib, CATALOG);
    expect(back.installed).toEqual(lib.installed);
    expect(back.enabled).toEqual(lib.enabled);
  });

  it("**自定义能力：往返后装/启用也要还在**（§49 那个 bug 就死在这一条上）", () => {
    const item = { id: "own-1", name: "查股价", hint: "按代码查价", type: "skill" as const };
    let lib = addCustom(EMPTY_LIBRARY, item);
    lib = toggleEnabled(toggleInstalled(lib, item.id), item.id);

    const back = roundTrip(lib, CATALOG);

    expect(back.custom).toHaveLength(1);
    expect(back.installed, "自定义条目往返后从 installed 里掉了").toContain(item.id);
    expect(back.enabled, "自定义条目往返后从 enabled 里掉了").toContain(item.id);
  });

  it("内置与自定义混在一起时，两者的状态都留住", () => {
    const item = { id: "own-2", name: "甲", hint: "说明", type: "plugin" as const };
    let lib = addCustom(toggleInstalled(EMPTY_LIBRARY, "builtin-1"), item);
    lib = toggleEnabled(toggleInstalled(lib, item.id), item.id);

    const back = roundTrip(lib, CATALOG);
    expect(back.installed.sort()).toEqual(["builtin-1", item.id].sort());
    expect(back.enabled).toEqual([item.id]);
  });

  it("**反复往返是幂等的**（第二次和第一次结果一样）", () => {
    const item = { id: "own-3", name: "乙", hint: "说明", type: "skill" as const };
    let lib = addCustom(EMPTY_LIBRARY, item);
    lib = toggleEnabled(toggleInstalled(lib, item.id), item.id);

    const once = roundTrip(lib, CATALOG);
    const twice = roundTrip(once, CATALOG);
    expect(twice).toEqual(once);
  });

  it("不变量只在「该留的」范围内成立：真幽灵条目仍要剔掉", () => {
    // 既不在目录、也不是自定义 → 确实该剔（不变量不是"什么都留"）
    const lib: Library = { ...EMPTY_LIBRARY, installed: ["builtin-1", "谁也不是"], enabled: ["谁也不是"] };
    const back = roundTrip(lib, CATALOG);
    expect(back.installed).toEqual(["builtin-1"]);
    expect(back.enabled).toEqual([]);
  });

  it("自定义条目被删掉后，往返不会再把它变回来（删是真的删）", () => {
    const item = { id: "own-4", name: "丙", hint: "说明", type: "skill" as const };
    const lib = JSON.parse(JSON.stringify({ ...EMPTY_LIBRARY, custom: [item], installed: [item.id] })) as Library;
    // 模拟"删掉自定义条目"——它的 id 就不该再算合法
    const withoutItem: Library = { ...lib, custom: [] };
    const back = roundTrip(withoutItem, CATALOG);
    expect(back.custom).toEqual([]);
    expect(back.installed).toEqual([]);
  });
});
