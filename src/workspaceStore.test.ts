import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 工作区授权：**落盘失败时不许"只活在内存里"**（2026-10-16，审计 P231）。
 *
 * ## 钉住的是哪件事
 *
 * `workspaceStore` 有一份同步缓存（`workspaceDirsSync()`），每个工具的 `ownedDirs()`
 * 直接读它 —— 授权一进缓存，agent 当场就能往那个目录写文件。
 *
 * 原来 `save()` 是：先 `store.write`，**不管成功与否**都 `cache = next.dirs`（失败只打一行日志）。
 * 于是一条授权即使一次都没写进磁盘，本会话里也已经生效了，重启后又消失 ——
 * 而且界面还会弹「已授权 …」那行回执。三处口径互相不一致。
 *
 * ## 怎么测
 *
 * 照 `src/ipcStores.test.ts` 的范式：把 `electron` 与 `jsonStore` 换成**可控的假实现**
 * （这样"落盘失败"能被稳定制造出来，不必真去弄坏磁盘），断言的是**缓存这个可观察结果**，
 * 不是"函数被调过"。
 *
 * ## 变异实证
 *
 * · 把 `save()` 退回"无条件 `cache = next.dirs`" → 第一个用例红；
 * · 去掉 `addWorkspaceFromDialog` 里那句"没落盘就不算成功" → 第一个用例回执那行红。
 */

const h = vi.hoisted(() => ({
  /** 落盘是否成功（用例改它来制造"写失败"）。 */
  writeOk: true,
  /** 磁盘上的列表（假 store 的"磁盘"）。 */
  dirs: [] as string[],
  /** 选择器返回的目录：按平台给一个绝对路径（相对路径会被实现防御性拒掉）。 */
  picked: "",
  canceled: false,
  writes: 0,
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/fake-userdata" },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
  dialog: {
    showOpenDialog: async () =>
      h.canceled ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [h.picked] },
  },
}));

vi.mock("../electron/ipc/jsonStore", () => ({
  createJsonStore: () => ({
    read: async () => ({ data: { dirs: [...h.dirs] }, foreign: false, note: "" }),
    write: async (value: { dirs: string[] }) => {
      h.writes += 1;
      if (!h.writeOk) return { ok: false, error: "磁盘写不进去" };
      h.dirs = [...value.dirs];
      return { ok: true };
    },
  }),
}));

const { addWorkspaceFromDialog, loadWorkspaces, removeWorkspace, workspaceDirsSync } = await import(
  "../electron/ipc/workspaceStore"
);

beforeEach(async () => {
  h.writeOk = true;
  h.dirs = [];
  h.canceled = false;
  h.writes = 0;
  h.picked = process.platform === "win32" ? "C:\\work\\proj" : "/work/proj";
  await loadWorkspaces();
});

describe("授权目录落盘失败时的一致性（P231）", () => {
  it("⭐ 落盘失败：工具不许当场拿到这份授权，也不许回一句「已授权」", async () => {
    h.writeOk = false;
    const got = await addWorkspaceFromDialog(null);

    expect(h.writes, "得真试过写").toBeGreaterThan(0);
    expect(
      workspaceDirsSync(),
      "落盘没成功，内存缓存就不许把它当真授权 —— 否则 agent 立刻能往里写文件，重启后授权又没了",
    ).toEqual([]);
    expect(got.dir, "没落盘成功就不能给成功回执（界面会照它显示「已授权」）").toBeNull();
    expect(got.list.dirs).toEqual([]);
  });

  it("落盘成功才真的生效：缓存与该次回执都对得上", async () => {
    const got = await addWorkspaceFromDialog(null);
    expect(got.dir).toBe(h.picked);
    expect(got.list.dirs).toEqual([h.picked]);
    expect(workspaceDirsSync()).toEqual([h.picked]);
  });

  it("撤销也一样：落盘失败就不许从缓存里摘掉（否则工具还在用、磁盘上还在）", async () => {
    await addWorkspaceFromDialog(null);
    h.writeOk = false;
    const after = await removeWorkspace(h.picked);
    expect(after.dirs, "写失败时返回的必须是磁盘上真实的那份列表").toEqual([h.picked]);
    expect(workspaceDirsSync()).toEqual([h.picked]);
  });

  it("用户取消：什么都不动，也不报错", async () => {
    h.canceled = true;
    const before = workspaceDirsSync();
    const got = await addWorkspaceFromDialog(null);
    expect(got.dir).toBeNull();
    expect(workspaceDirsSync()).toEqual(before);
    expect(h.writes, "取消不该触发落盘").toBe(0);
  });
});
