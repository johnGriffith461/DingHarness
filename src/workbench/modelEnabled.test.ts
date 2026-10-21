import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MODEL_SETTINGS_KEY,
  enabledAfterPull,
  migrateStore,
  modelsForProvider,
  readModelSettings,
  saveProviderModels,
} from "./modelSettingsStore";

/**
 * M-05：`enabled` 的语义（主人报的第 3 条：拉取模型默认全选）。
 *
 * 关键判据只有两条：
 * 1. **新供应商拉完 = 0 勾**（不再替用户做决定）；
 * 2. **旧数据不会消失**（缺 `enabled` 的历史条目迁移成显式全量）。
 */

/** node 环境没有 localStorage：给一个最小的内存实现。 */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = fakeStorage();
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("拉取后的启用清单", () => {
  it("⭐ 新供应商：一个都不勾", () => {
    expect(enabledAfterPull(undefined, ["a", "b", "c"])).toEqual([]);
  });

  it("已有供应商刷新：保留交集（下架的模型自然消失）", () => {
    expect(enabledAfterPull({ models: ["a", "b", "c"], enabled: ["b", "c"] }, ["a", "b", "d"])).toEqual(["b"]);
  });

  it("交集按**拉回来的顺序**排（界面顺序稳定）", () => {
    expect(enabledAfterPull({ enabled: ["c", "a"] }, ["a", "b", "c"])).toEqual(["a", "c"]);
  });
});

describe("旧数据迁移", () => {
  it("缺 enabled 的条目按当年的语义迁成显式全量", () => {
    const got = migrateStore({ deepseek: { models: ["a", "b"], default: "a" } });
    expect(got.changed).toBe(true);
    expect(got.store.deepseek).toEqual({ models: ["a", "b"], enabled: ["a", "b"], default: "a" });
  });

  it("已有 enabled 的原样保留（含空数组 —— 它就是「一个都没有」）", () => {
    const got = migrateStore({ x: { models: ["a"], enabled: [] } });
    expect(got.changed).toBe(false);
    expect(got.store.x?.enabled).toEqual([]);
  });

  it("坏条目丢掉，不影响好的条目", () => {
    const got = migrateStore({ ok: { models: ["a"], enabled: ["a"] }, bad: "nope", worse: null });
    expect(Object.keys(got.store)).toEqual(["ok"]);
    expect(got.changed).toBe(true);
  });

  it("⭐ readModelSettings 发现迁移会**立刻写回**（下一次读到的就是显式全量）", () => {
    localStorage.setItem(MODEL_SETTINGS_KEY, JSON.stringify({ p: { models: ["m1", "m2"] } }));
    expect(readModelSettings().p?.enabled).toEqual(["m1", "m2"]);
    const onDisk = JSON.parse(localStorage.getItem(MODEL_SETTINGS_KEY) ?? "{}") as Record<string, { enabled?: string[] }>;
    expect(onDisk.p?.enabled).toEqual(["m1", "m2"]);
  });
});

describe("输入区选择器读什么", () => {
  it("有设置：只列 enabled；enabled 为空就是 0 个", () => {
    saveProviderModels("p", { models: ["a", "b"], enabled: ["b"] });
    expect(modelsForProvider("p", ["a", "b"]).models).toEqual(["b"]);
    saveProviderModels("p", { models: ["a", "b"], enabled: [] });
    const got = modelsForProvider("p", ["a", "b"]);
    expect(got.models).toEqual([]);
    expect(got.emptyEnabled).toBe(true);
  });

  it("从未动过设置：按 provider 表里的清单（老用户不会被清空）", () => {
    const got = modelsForProvider("never", ["a", "b"]);
    expect(got.models).toEqual(["a", "b"]);
    expect(got.hasSettings).toBe(false);
  });
});
