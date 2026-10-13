import { describe, expect, it } from "vitest";
import {
  addCustom,
  EMPTY_LIBRARY,
  normalizeLibrary,
  removeCustom,
  toggleEnabled,
  toggleInstalled,
  type CustomItem,
  type Library,
} from "@shared/library";

/**
 * 自定义能力（对标插件页的「添加」）。
 *
 * 本机版没有插件市场后端，所以「安装」的诚实对应物是**自己加一条**。
 * 这一层的要点全在"收窄"和"不留下悬空引用"上。
 */

const CATALOG = new Set(["a"]);
const item = (patch: Partial<CustomItem> = {}): CustomItem => ({
  id: "c1",
  name: "查股价",
  hint: "按股票代码查当前价格",
  type: "skill",
  ...patch,
});

const withCustom = (list: CustomItem[]): Library => ({ ...EMPTY_LIBRARY, custom: list });

describe("addCustom", () => {
  it("加一条", () => {
    const out = addCustom(EMPTY_LIBRARY, item());
    expect(out.custom).toHaveLength(1);
    expect(out.custom[0].name).toBe("查股价");
  });

  it("名字两端空白被清掉", () => {
    expect(addCustom(EMPTY_LIBRARY, item({ name: "  查股价  " })).custom[0].name).toBe("查股价");
  });

  it("**名字或说明为空不加**（说明会进系统提示词，空的等于没加）", () => {
    expect(addCustom(EMPTY_LIBRARY, item({ name: " " })).custom).toHaveLength(0);
    expect(addCustom(EMPTY_LIBRARY, item({ hint: "  " })).custom).toHaveLength(0);
  });

  it("**重名不加**（名字是它的标识，两条同名会让「启用哪一条」说不清）", () => {
    const once = addCustom(EMPTY_LIBRARY, item());
    const twice = addCustom(once, item({ id: "c2" }));
    expect(twice.custom).toHaveLength(1);
    expect(twice).toBe(once);
  });
});

describe("removeCustom", () => {
  it("**同时从 installed 与 enabled 里清掉**（否则留下悬空引用）", () => {
    const lib: Library = {
      ...withCustom([item()]),
      installed: ["c1", "a"],
      enabled: ["c1"],
    };
    const out = removeCustom(lib, "c1");
    expect(out.custom).toHaveLength(0);
    expect(out.installed).toEqual(["a"]);
    expect(out.enabled).toEqual([]);
  });

  it("删不存在的 id 不动别的", () => {
    const lib = withCustom([item()]);
    expect(removeCustom(lib, "nope").custom).toHaveLength(1);
  });
});

describe("custom 与装/启用串起来", () => {
  it("自定义条目能被安装、也能被启用（和目录条目走同一套）", () => {
    const lib = addCustom(EMPTY_LIBRARY, item());
    // 注意：toggleInstalled 不查目录（目录 id 只在载入时收窄），所以这里能装
    const installed = toggleInstalled(lib, "c1");
    expect(installed.installed).toContain("c1");
    expect(toggleEnabled(installed, "c1").enabled).toContain("c1");
  });
});

describe("normalizeLibrary 对 custom 的处理", () => {
  it("正常内容原样收下", () => {
    const out = normalizeLibrary({ custom: [item()] }, CATALOG, null);
    expect(out.custom).toEqual([item()]);
  });

  it("**不按目录 id 剔**（自定义条目本来就不在目录里）", () => {
    const out = normalizeLibrary({ custom: [item()] }, CATALOG, null);
    expect(out.custom).toHaveLength(1);
  });

  it("缺 id / 名字 / 说明的整条丢掉（缺了就没法引用或没法展示）", () => {
    const out = normalizeLibrary(
      { custom: [{ name: "甲", hint: "说明" }, { id: "x", hint: "说明" }, { id: "y", name: "乙" }, item()] },
      CATALOG,
      null,
    );
    expect(out.custom).toHaveLength(1);
    expect(out.custom[0].id).toBe("c1");
  });

  it("坏字段退成空数组，不整份丢掉", () => {
    const out = normalizeLibrary({ custom: "不是数组", installed: ["a"] }, CATALOG, null);
    expect(out.custom).toEqual([]);
    expect(out.installed).toEqual(["a"]);
  });

  it("type 只认 skill 或 plugin（别的一律当 plugin）", () => {
    const out = normalizeLibrary({ custom: [{ id: "z", name: "甲", hint: "说明", type: "乱来" }] }, CATALOG, null);
    expect(out.custom[0].type).toBe("plugin");
  });

  it("**自定义条目的 id 要算合法** —— 否则装/启用状态在下次载入时被剔掉", () => {
    /*
     * 这条是实测撞出来的：加完能用、**重启就没了**。
     * 根因是 installed/enabled 只拿静态目录收窄，自定义 id 不在目录里 → 被当幽灵条目剔掉。
     * 断言就钉这一点：载入后 custom 非空时，它的装/启用状态必须留住。
     */
    const out = normalizeLibrary(
      { custom: [item()], installed: ["c1", "不在目录里"], enabled: ["c1"] },
      CATALOG,
      null,
    );
    expect(out.custom).toHaveLength(1);
    expect(out.installed).toContain("c1");
    expect(out.enabled).toContain("c1");
    // 而真正的幽灵条目（既不在目录、也不是自定义）仍要剔掉
    expect(out.installed).not.toContain("不在目录里");
  });

  it("自定义条目被删掉后，它的 id 就不再合法（装/启用一并清掉）", () => {
    const out = normalizeLibrary({ custom: [], installed: ["c1"], enabled: ["c1"] }, CATALOG, null);
    expect(out.installed).toEqual([]);
    expect(out.enabled).toEqual([]);
  });
});
