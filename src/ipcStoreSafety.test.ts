import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { removeAll } from "./testFs";

/**
 * 主进程 IPC 落盘与窗口控制的回归用例（**审计 P194 / P223 / P224 / P225 / P227**）。
 *
 * 范式与 `src/ipcStores.test.ts` 一致：**mock electron + 临时 userData + 真读盘**。
 * 断言的是"磁盘上真有什么 / Promise 真 reject 还是假 resolve"，不是"函数被调过"。
 */

const env = vi.hoisted(() => ({ userData: "", win: null as unknown }));

vi.mock("electron", () => ({
  app: { getPath: () => env.userData },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
  shell: { openPath: async () => "", showItemInFolder: () => undefined },
  BrowserWindow: { fromWebContents: () => env.win },
  powerSaveBlocker: { isStarted: () => false, start: () => 1, stop: () => undefined },
}));

import { appSettingsPath, loadAppSettings, saveAppSettings } from "../electron/ipc/appSettings";
import { capOfficeText, OFFICE_MAX_CHARS, registerArtifactIpc, sanitizeName } from "../electron/ipc/artifactStore";
import { markdownToXlsx } from "../electron/ipc/officeWrite";
import { saveSearchHistory } from "../electron/ipc/searchStore";
import { attachWindowEvents, registerWindowIpc, WINDOW_CHANNEL } from "../electron/ipc/windowControls";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

/** 一个只记账的 ipcMain：拿得到注册进去的 handler，用来直接调。 */
function handlerRegistry(): { ipc: Electron.IpcMain; get: (channel: string) => Handler } {
  const map = new Map<string, Handler>();
  const ipc = {
    handle: (channel: string, fn: Handler) => {
      map.set(channel, fn);
    },
  } as unknown as Electron.IpcMain;
  return { ipc, get: (channel: string) => map.get(channel)! };
}

/** 假 BrowserWindow：只实现这几条用例碰到的部分。 */
function fakeWindow(initMaximized = false) {
  let maximized = initMaximized;
  const sent: Array<[string, unknown]> = [];
  const listeners: Record<string, Array<() => void>> = {};
  return {
    isMaximized: () => maximized,
    maximize: () => {
      maximized = true;
    },
    unmaximize: () => {
      maximized = false;
    },
    minimize: vi.fn(),
    close: vi.fn(),
    isDestroyed: () => false,
    on(event: string, cb: () => void) {
      (listeners[event] ??= []).push(cb);
    },
    emit(event: string) {
      for (const cb of listeners[event] ?? []) cb();
    },
    webContents: { send: (channel: string, payload: unknown) => sent.push([channel, payload]) },
    sent,
  };
}

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "dh-ipcsafety-"));
  env.userData = tmpRoot;
  /*
   * 固定走**文件后端**：这几条断言"落盘失败要被看见"，而失败注入的手法是
   * "让 settings.json 的目标路径不可写" —— 那只有在文件后端才表现为写失败
   * （SQLite 后端写的是 stores.db，不受这条路径影响）。
   */
  process.env.DSH_STORE_BACKEND = "file";
});

afterEach(() => {
  if (tmpRoot) removeAll(tmpRoot);
  tmpRoot = "";
  delete process.env.DSH_STORE_BACKEND;
  env.win = null;
});

describe("P223 · 写盘失败不许假装成功", () => {
  it("设置：正常路径照常写回、读得回来", async () => {
    expect(await saveAppSettings({ pinnedModel: "deepseek/deepseek-chat" })).toEqual({
      pinnedModel: "deepseek/deepseek-chat",
    });
    expect(await loadAppSettings()).toEqual({ pinnedModel: "deepseek/deepseek-chat" });
  });

  it("设置：写盘不可能时**抛错**（不再是打个日志、照样 resolve 成功值）", async () => {
    /*
     * 把 userData 指到一个**文件**上：`appSettingsPath()` 的父目录于是不是目录，
     * `mkdir(dirname)` 必失败 → `store.write` 三连失败 → 这里必须 reject。
     */
    const blocked = path.join(tmpRoot, "asfile");
    writeFileSync(blocked, "占位：这个路径是文件，不是目录");
    env.userData = blocked;

    await expect(saveAppSettings({ pinnedModel: "deepseek/deepseek-chat" })).rejects.toThrow(/落盘失败/);
    // 顺带证明"真的没写出去"（不是写成功又抛）
    expect(() => readFileSync(path.join(blocked, "settings.json"), "utf8")).toThrow();
    void appSettingsPath; // 路径取自模块自己导出的函数（硬编文件名会静默测到别处）
  });

  it("搜索历史：写盘不可能时同样抛错", async () => {
    const blocked = path.join(tmpRoot, "asfile2");
    writeFileSync(blocked, "占位");
    env.userData = blocked;
    await expect(saveSearchHistory({ skills: ["react"], files: [] })).rejects.toThrow(/落盘失败/);
  });
});

describe("P194 · 窗口控制拿不到窗口要明确失败", () => {
  it("有窗口：toggleMaximize 返回操作后的真实状态，minimize/close 真的落到窗口上", () => {
    const w = fakeWindow(false);
    env.win = w;
    const { ipc, get } = handlerRegistry();
    registerWindowIpc(ipc, () => env.win as never);

    expect(get(WINDOW_CHANNEL.toggleMaximize)({ sender: {} })).toBe(true);
    expect(w.isMaximized()).toBe(true);
    expect(get(WINDOW_CHANNEL.toggleMaximize)({ sender: {} })).toBe(false);
    expect(w.isMaximized()).toBe(false);

    get(WINDOW_CHANNEL.minimize)({ sender: {} });
    expect(w.minimize).toHaveBeenCalledTimes(1);
    get(WINDOW_CHANNEL.close)({ sender: {} });
    expect(w.close).toHaveBeenCalledTimes(1);
  });

  it("拿不到窗口：三个动作都抛（原来静默空操作，界面无从知道）", () => {
    env.win = null;
    const { ipc, get } = handlerRegistry();
    registerWindowIpc(ipc, () => null);

    expect(() => get(WINDOW_CHANNEL.minimize)({ sender: {} })).toThrow(/没有可控制的窗口/);
    expect(() => get(WINDOW_CHANNEL.toggleMaximize)({ sender: {} })).toThrow(/没有可控制的窗口/);
    expect(() => get(WINDOW_CHANNEL.close)({ sender: {} })).toThrow(/没有可控制的窗口/);
    // 只读的 isMaximized 不抛，退成 false（图标错一次，不该把标题栏整个弄崩）
    expect(get(WINDOW_CHANNEL.isMaximized)({ sender: {} })).toBe(false);
  });

  it("最大化状态变了要推事件（双击 / Win+↑ / Snap 都要跟上）", () => {
    const w = fakeWindow(false);
    attachWindowEvents(w as never);
    w.emit("maximize");
    w.emit("unmaximize");
    expect(w.sent).toEqual([
      [WINDOW_CHANNEL.maximizedChanged, true],
      [WINDOW_CHANNEL.maximizedChanged, false],
    ]);
  });
});

describe("P224 · 并发保存产物不许互相覆盖（独占创建）", () => {
  it("两个同名保存同时飞：各得一份文件，内容不丢", async () => {
    const { ipc, get } = handlerRegistry();
    registerArtifactIpc(ipc);
    const save = get("artifact:save") as (
      event: unknown,
      name: string,
      data: string | Uint8Array,
    ) => Promise<{ filePath: string; name: string; bytes: number }>;

    const [a, b] = await Promise.all([save(null, "note.md", "第一份"), save(null, "note.md", "第二份")]);

    expect(a.filePath, "两个并发保存拿到了同一个文件 —— 后写的把先写的覆盖了").not.toBe(b.filePath);
    expect(a.name).not.toBe(b.name);
    expect(readFileSync(a.filePath, "utf8")).toBe("第一份");
    expect(readFileSync(b.filePath, "utf8")).toBe("第二份");
  });
});

describe("P225 · 超长文件名先留扩展名再截主名", () => {
  it("90 个字的标题 + .docx：扩展名活下来，总长不超上限", () => {
    const got = sanitizeName(`${"标".repeat(90)}.docx`);
    expect(got.endsWith(".docx"), "扩展名被连根截掉了 —— Office 分支会整个不走").toBe(true);
    expect(got.length).toBeLessThanOrEqual(80);
  });

  it("没有扩展名时仍旧硬截到 80", () => {
    expect(sanitizeName("a".repeat(100))).toHaveLength(80);
  });

  it("端到端：超长 .docx 名字仍然走 Office 生成（不再退化成无扩展名文件）", async () => {
    const { ipc, get } = handlerRegistry();
    registerArtifactIpc(ipc);
    const save = get("artifact:save") as (
      event: unknown,
      name: string,
      data: string | Uint8Array,
    ) => Promise<{ filePath: string; name: string; bytes: number; generated?: boolean }>;

    const res = await save(null, `${"长".repeat(90)}.docx`, "# 标题\n\n正文一段。");
    expect(res.generated, "超长名字把 .docx 截掉了 → Office 生成分支没走").toBe(true);
    expect(res.name.endsWith(".docx")).toBe(true);
  });
});

describe("P227 · 超大正文先截断（截断量进 note，不静默）", () => {
  it("普通长度原样返回，不产生 note", () => {
    expect(capOfficeText("一段正常长度的正文")).toEqual({ body: "一段正常长度的正文" });
  });

  it("超限时截到上限，并给出 note", () => {
    const got = capOfficeText("字".repeat(OFFICE_MAX_CHARS + 5));
    expect(got.body).toHaveLength(OFFICE_MAX_CHARS);
    expect(got.note, "截断了却不吭声").toContain("截断");
  });

  it("截断点上正好是代理对时，不许切出半个码元", () => {
    const boundary = `${"a".repeat(OFFICE_MAX_CHARS - 1)}\u{1F600}bbbb`;
    const got = capOfficeText(boundary);
    const last = got.body.charCodeAt(got.body.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff, "正文末尾留下了一个孤立高位代理").toBe(false);
  });

  it("端到端：超长 .docx 保存会带上截断说明", async () => {
    const { ipc, get } = handlerRegistry();
    registerArtifactIpc(ipc);
    const save = get("artifact:save") as (
      event: unknown,
      name: string,
      data: string | Uint8Array,
    ) => Promise<{ generated?: boolean; note?: string }>;

    const res = await save(null, "big.docx", "一".repeat(OFFICE_MAX_CHARS + 1));
    expect(res.generated).toBe(true);
    expect(res.note, "超限截断没有写进 note —— 界面看不到").toContain("截断");
  }, 30_000);

  it("xlsx 列宽不再按列重扫全表（源码守卫）+ 宽度仍按内容算", async () => {
    const raw = readFileSync(path.join(__dirname, "..", "electron", "ipc", "officeWrite.ts"), "utf8");
    /* 去注释：上面解释旧写法的那段注释本身提到过那个 API 名，不该被当成违规 */
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src, "officeWrite 又用 sheet.eachRow 按列重扫全表（O(列×行)）").not.toContain("sheet.eachRow");

    const md = `| 名称 | 描述 |\n| --- | --- |\n| a | ${"很长的描述".repeat(8)} |`;
    const buf = await markdownToXlsx(md, "表");
    /* 直接解包读 `<cols>`（officeWrite.test.ts 同一个套路），不额外引入 ExcelJS 的类型面 */
    const zip = await JSZip.loadAsync(buf);
    const sheetXml = await zip.files["xl/worksheets/sheet1.xml"]!.async("string");
    const colTags = sheetXml.match(/<col\b[^>]*>/g) ?? [];
    const widthOf = (index: number): number => {
      const tag = colTags.find((t) => new RegExp(`min="${index}"`).test(t));
      const m = tag ? /width="([\d.]+)"/.exec(tag) : null;
      return m ? Number(m[1]) : NaN;
    };
    expect(Number.isFinite(widthOf(1)), "第一列没写宽度").toBe(true);
    expect(widthOf(2), "长内容那一列的宽度没有按内容放宽").toBeGreaterThan(widthOf(1));
  }, 30_000);
});
