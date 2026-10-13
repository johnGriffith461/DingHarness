import { beforeEach, describe, expect, it, vi } from "vitest";

import { THEME_KEY, THEME_OPTIONS, readTheme, resolvesToDark, saveTheme, startTheme } from "./theme";

/**
 * 外观设置（三选一）的行为锁定。
 *
 * 口径来自本体账号菜单里的「外观设置」子菜单：跟随系统 / 浅色模式 / 深色模式。
 * 这里锁三件事：
 *   1. 三档的**解析规则**（尤其"跟随系统"不是一种颜色，而是一条规则）；
 *   2. 存档的**往返**与容错（脏值要退回默认档，不能抛）；
 *   3. "跟随系统"要**跟着系统变化**，而不是只在启动时读一次。
 */

/** 最小 localStorage 桩：只实现这个模块用到的三个方法。 */
function stubStorage(): void {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
}

/**
 * 最小 matchMedia 桩，可手动触发变化事件。
 *
 * `matches` 必须读**当前**状态而不是创建时捕获 —— 真实浏览器里
 * `matchMedia(q).matches` 每次都反映现状，`applyTheme` 也正是这么用的。
 * （第一版把 matches 写死，于是"系统变了但界面没变"这条**假红**过一次。）
 *
 * @param matches 初始是否偏好深色
 * @returns `emit` 用来模拟系统主题变化
 */
function stubMatchMedia(matches: boolean): { emit: (next: boolean) => void } {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const state = { current: matches };
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return state.current;
    },
    media: query,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => void listeners.delete(fn),
  }));
  return {
    emit: (next) => {
      state.current = next;
      listeners.forEach((fn) => fn({ matches: next }));
    },
  };
}

/**
 * 最小 DOM 桩：applyDark 现在写的是 `documentElement` 的 `data-theme` 属性。
 *
 * 与本体一致 —— 属性缺失即"跟随系统"，所以 `has()` 读的是属性值，
 * `followsSystem()` 读的是属性**在不在**。
 */
function stubRoot(): { has: () => boolean; theme: () => string | null; pref: () => string | null } {
  const attrs = new Map<string, string>();
  vi.stubGlobal("document", {
    documentElement: {
      setAttribute: (k: string, v: string) => void attrs.set(k, v),
      removeAttribute: (k: string) => void attrs.delete(k),
      getAttribute: (k: string) => attrs.get(k) ?? null,
    },
  });
  return {
    has: () => attrs.get("data-theme") === "dark",
    theme: () => attrs.get("data-theme") ?? null,
    pref: () => attrs.get("data-theme-pref") ?? null,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  stubStorage();
  stubMatchMedia(false);
  stubRoot();
});

describe("外观设置：三档解析", () => {
  it("本体的三档与顺序一致", () => {
    expect(THEME_OPTIONS.map((o) => o.value)).toEqual(["system", "light", "dark"]);
    expect(THEME_OPTIONS.map((o) => o.label)).toEqual(["跟随系统", "浅色模式", "深色模式"]);
  });

  it("「深色模式」与「浅色模式」不看系统偏好", () => {
    expect(resolvesToDark("dark", false)).toBe(true);
    expect(resolvesToDark("dark", true)).toBe(true);
    expect(resolvesToDark("light", true)).toBe(false);
    expect(resolvesToDark("light", false)).toBe(false);
  });

  it("「跟随系统」跟着系统走 —— 它不是一种颜色，是一条规则", () => {
    expect(resolvesToDark("system", true)).toBe(true);
    expect(resolvesToDark("system", false)).toBe(false);
  });
});

describe("外观设置：存档往返与容错", () => {
  it("没存过时给「跟随系统」（与本体默认一致）", () => {
    expect(readTheme()).toBe("system");
  });

  it("存了能读回来，三档各自往返", () => {
    for (const t of ["system", "light", "dark"] as const) {
      saveTheme(t);
      expect(readTheme()).toBe(t);
    }
  });

  it("脏值退回默认档，不抛", () => {
    localStorage.setItem(THEME_KEY, "blue");
    expect(readTheme()).toBe("system");
    localStorage.setItem(THEME_KEY, "");
    expect(readTheme()).toBe("system");
  });

  it("存不进去也要本次生效（比点了没反应好）", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    });
    const root = stubRoot();
    expect(() => saveTheme("dark")).not.toThrow();
    expect(root.has()).toBe(true);
  });
});

describe("外观设置：跟随系统要真的'跟随'", () => {
  it("系统主题变化时，选「跟随系统」的界面立刻跟着变", () => {
    const mq = stubMatchMedia(false);
    const root = stubRoot();
    saveTheme("system");
    expect(root.has()).toBe(false); // 系统浅色
    expect(root.pref()).toBeNull(); // 「跟随系统」= 不记偏好

    const stop = startTheme();
    mq.emit(true); // 系统切深色
    expect(root.has()).toBe(true);

    mq.emit(false);
    expect(root.has()).toBe(false);
    stop();
  });

  it("选了具体一档时会记下偏好（「跟随系统」则不记）", () => {
    const root = stubRoot();
    saveTheme("dark");
    expect(root.pref()).toBe("dark");
    saveTheme("light");
    expect(root.pref()).toBe("light");
    saveTheme("system");
    expect(root.pref()).toBeNull();
  });

  it("选了「浅色模式」时，系统切深色**不该**影响界面", () => {
    const mq = stubMatchMedia(false);
    const root = stubRoot();
    saveTheme("light");

    const stop = startTheme();
    mq.emit(true); // 系统切深色，但用户明确选了浅色
    expect(root.has()).toBe(false);
    stop();
  });

  it("解绑之后系统再变就不该动了", () => {
    const mq = stubMatchMedia(false);
    const root = stubRoot();
    saveTheme("system");
    const stop = startTheme();
    stop();

    mq.emit(true);
    expect(root.has()).toBe(false);
  });
});
