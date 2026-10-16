import { beforeEach, describe, expect, it } from "vitest";

import { navCollapsedNow, startNavCollapsedSync, useAppSettings } from "./appSettings";

/**
 * 左栏收起态要**跨重启记住**（2026-10-16，审计 P187 / P191）。
 *
 * ## 这条守卫挡的是什么
 *
 * `store.ts` 里的 `navCollapsed` 只活在内存：关掉再开，左栏自己弹回来 ——
 * 用户每开一次都要再收一次。它是一个"用户设过一次的东西"，与钉住的默认模型同一类，
 * 所以走同一条落盘（`appSettings`，主进程原子写，§156 的教训）。
 *
 * 这里钉三件事：
 *   · **落盘与读回**：收起态进得去、回得来（`read/write` 两个字段一起走，
 *     不能因为写收起态就把钉住的模型抹掉）；
 *   · **接线**：载入完成那一刻把盘上的值灌进界面状态；之后界面一变就写回；
 *   · **时序**：灌进去那一次不回写；载入没回来时用户先按了，以他按的为准。
 */

/** 极简假桥：只给这次要用的那个通道。 */
function installShell(parts: Record<string, unknown>): void {
  (globalThis as unknown as { shell?: unknown }).shell = parts;
}

/** 一份「磁盘上」的设置 —— 假桥把它读回来、把写进去的记下来。 */
function fakeDisk(initial: Record<string, unknown>): { writes: Array<Record<string, unknown>>; disk: Record<string, unknown> } {
  const disk = { ...initial };
  const writes: Array<Record<string, unknown>> = [];
  installShell({
    appSettings: {
      read: async () => ({ ...disk }),
      write: async (next: Record<string, unknown>) => {
        writes.push({ ...next });
        Object.assign(disk, next);
        return { ...disk };
      },
    },
  });
  return { writes, disk };
}

beforeEach(() => {
  useAppSettings.setState({ pinnedModel: "", navCollapsed: false, loaded: false, note: "" });
});

describe("收起态进得去、回得来（P187 / P191）", () => {
  it("⭐ 写盘带**两个字段**：写收起态不许把钉住的默认模型抹掉", async () => {
    /* 载入先跑一遍，把"钉住的模型"放进内存（这是界面上真会发生的样子） */
    const { writes } = fakeDisk({ pinnedModel: "deepseek/deepseek-chat", navCollapsed: false });
    await useAppSettings.getState().load();
    expect(useAppSettings.getState().pinnedModel).toBe("deepseek/deepseek-chat");

    await useAppSettings.getState().setNavCollapsed(true);
    expect(writes.length).toBe(1);
    expect(writes[0]!.navCollapsed, "收起态没写进去 —— 重启还是会忘").toBe(true);
    expect(
      writes[0]!.pinnedModel,
      "只送了自己那一项：盘上钉住的模型被抹掉了（用户重启后会发现默认通道没了）",
    ).toBe("deepseek/deepseek-chat");
  });

  it("⭐ 重启之后还是收起的样子（`load` 把盘上那份读回来）", async () => {
    fakeDisk({ pinnedModel: "", navCollapsed: true });
    await useAppSettings.getState().load();
    expect(useAppSettings.getState().navCollapsed).toBe(true);
    expect(navCollapsedNow()).toBe(true);
  });

  it("盘上没有这个字段（这次修复之前的 `settings.json`）→ 展开，不报缺字段", async () => {
    fakeDisk({ pinnedModel: "a/b" });
    await useAppSettings.getState().load();
    expect(useAppSettings.getState().navCollapsed).toBe(false);
    expect(useAppSettings.getState().loaded).toBe(true);
  });

  it("盘上写的是坏值（不是布尔）→ 展开（左栏莫名收起来，用户会找不到导航）", async () => {
    fakeDisk({ pinnedModel: "", navCollapsed: "yes" });
    await useAppSettings.getState().load();
    expect(useAppSettings.getState().navCollapsed).toBe(false);
  });

  it("写盘失败 → 回滚到改动前，并留下一句说明", async () => {
    installShell({
      appSettings: {
        read: async () => ({ pinnedModel: "", navCollapsed: false }),
        write: async () => {
          throw new Error("磁盘只读");
        },
      },
    });
    await useAppSettings.getState().setNavCollapsed(true);
    const state = useAppSettings.getState();
    expect(state.navCollapsed, "界面收起了、盘上没记 —— 重启自己弹回来，用户以为没记住").toBe(false);
    expect(state.note).toContain("没能记住");
  });
});

describe("接线：盘上的值灌进界面状态、界面一变就写回", () => {
  /** 一份可控的「界面状态」端口（真身是 `workbench/store.ts` 的 `navCollapsed`）。 */
  function fakeUi(initial: boolean) {
    const listeners = new Set<(value: boolean) => void>();
    const applied: boolean[] = [];
    let value = initial;
    return {
      applied,
      now: () => value,
      port: {
        read: navCollapsedNow,
        apply: (saved: boolean) => {
          applied.push(saved);
          value = saved;
        },
        subscribe: (onChange: (value: boolean) => void) => {
          listeners.add(onChange);
          return () => listeners.delete(onChange);
        },
      },
      /** 模拟用户按了那颗按钮。 */
      press: (next: boolean) => {
        value = next;
        for (const l of listeners) l(next);
      },
    };
  }

  it("⭐ 载入完成那一刻把盘上的值灌进界面状态（收起的样子真的回来了）", async () => {
    fakeDisk({ pinnedModel: "", navCollapsed: true });
    const ui = fakeUi(false);
    /* 真实时序：`NavSidebar` 的 effect 先挂上，`Workbench` 之后才 `load()` */
    const stop = startNavCollapsedSync(ui.port);
    expect(ui.applied, "载入还没回来就灌了？").toEqual([]);
    await useAppSettings.getState().load();
    expect(ui.applied).toEqual([true]);
    expect(ui.now()).toBe(true);
    stop();
  });

  it("⭐ 灌进去那一次**不回写**（否则每次启动都白写一次盘）", async () => {
    const { writes } = fakeDisk({ pinnedModel: "", navCollapsed: true });
    const ui = fakeUi(false);
    const stop = startNavCollapsedSync(ui.port);
    await useAppSettings.getState().load();
    /* 给它几拍：write 是异步发的 */
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(writes, "启动时的灌盘触发了写盘").toHaveLength(0);
    stop();
  });

  it("⭐ 之后用户按一下：新值落盘（这才是「记住」）", async () => {
    const { writes } = fakeDisk({ pinnedModel: "", navCollapsed: false });
    const ui = fakeUi(false);
    const stop = startNavCollapsedSync(ui.port);
    await useAppSettings.getState().load();
    ui.press(true);
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(writes.at(-1)?.navCollapsed).toBe(true);
    stop();
  });

  it("⭐ 载入还没回来时用户先按了：以他按的为准（别被盘上的旧值啪地弹回去）", async () => {
    fakeDisk({ pinnedModel: "", navCollapsed: false });
    const ui = fakeUi(true); // 用户刚点成「收起」
    const stop = startNavCollapsedSync(ui.port);
    ui.press(true);
    await useAppSettings.getState().load();
    expect(ui.applied, "用户刚按完，盘上的旧值又把它盖回去了").toEqual([]);
    expect(ui.now()).toBe(true);
    stop();
  });

  it("停止之后不再写盘（组件卸载了不该还在改设置）", async () => {
    const { writes } = fakeDisk({ pinnedModel: "", navCollapsed: false });
    const ui = fakeUi(false);
    const stop = startNavCollapsedSync(ui.port);
    await useAppSettings.getState().load();
    stop();
    ui.press(true);
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(writes).toHaveLength(0);
  });
});
