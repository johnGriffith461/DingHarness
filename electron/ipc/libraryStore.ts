import { app } from "electron";
import path from "node:path";

import { createJsonStore } from "./jsonStore";

/**
 * 本机库的持久化（阶段 11.7 / 11.8）：装过的插件、项目、置顶、收藏。
 *
 * 与定时任务同一套做法：**临时文件 + rename 原子写**。
 * 这个文件比任务列表更常被改（装一次就写一次），所以原子性更要紧 ——
 * 写坏的后果是"插件全没了 / 项目全没了"，用户会以为应用出了问题。
 *
 * **收窄放在渲染层**（`normalizeLibrary`）：主进程只管存取字节，
 * 因为它不知道当前目录里有哪些 id、哪些任务还活着 —— 那两样都只有渲染层清楚。
 *
 * ── C1（2026-10-13）：落盘收进 `./jsonStore` ──
 *
 * 原来这个文件自己写了一遍"读 json / 写 json"（含 `.tmp` + `rename` 原子写）。
 * 那份写法本身没错，毛病是它**没有写失败重试**，而且各模块各写一份、强度不一。
 * 现在与其它几个库共用同一套落盘（原子写 + 写失败重试 3 次 + 信封带版本）。
 *
 * ⚠️ 磁盘上现存的 `library.json` 是**裸 JSON**（没有信封）—— 它被读成"版本 0"并原样迁上来，
 * 所以升级不会把用户装过的插件 / 建过的项目弄丢（见 `shared/persist.ts` 那条默认）。
 * 主进程这层的收窄只到"是个普通对象"为止：真正的收窄仍是渲染层的 `normalizeLibrary`。
 */

/** 通道名。 */
export const LIBRARY_CHANNEL = {
  load: "library:load",
  save: "library:save",
} as const;

/** 库文件路径。 */
export function libraryPath(): string {
  return path.join(app.getPath("userData"), "library.json");
}

/**
 * 主进程侧只把库收窄到"是个普通对象"。
 *
 * 为什么不在这里收窄成 `Library`：`normalizeLibrary` 要两份外部集合
 * （目录里现有的 id、当前活着的任务 id），主进程没有这两样（见上面的说明）。
 * 但"不是对象一律当空库"这一手仍要在这儿挡 —— 磁盘上一个手改过的 `[]` 或 `3`
 * 传下去会在渲染层炸出更难查的错。
 */
type LibraryBlob = Record<string, unknown>;

/** 把不可信的落盘值收窄成普通对象；不是对象就给空库。 */
function asLibraryBlob(value: unknown): LibraryBlob {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as LibraryBlob)
    : {};
}

/**
 * 落盘器（C1）。
 *
 * `file` 是**函数**：`app.getPath("userData")` 在打包前后不同，模块加载期求值会锁死第一次的结果。
 */
const store = createJsonStore<LibraryBlob>({
  file: libraryPath,
  initial: () => ({}),
  normalize: asLibraryBlob,
});

/**
 * 读库。
 * @returns 原始 JSON；文件不存在或内容坏了都返回空对象（**不让坏文件把应用卡住**）
 */
export async function loadLibrary(): Promise<unknown> {
  const got = await store.read();
  // 读不动（磁盘上是更新的版本）只报一声：这里给的是空库兜底值，界面照常起得来
  if (got.foreign) console.error("[library] 磁盘上的本机库读不动（保留原样）：", got.note);
  return got.data;
}

/**
 * 写库（原子写由 `./jsonStore` 负责）。
 *
 * ⚠️ 磁盘上是**更新的版本**时**拒绝覆盖**（`foreign`）：那是降级运行，
 * 硬写回去等于把用户装过的插件 / 建过的项目降级销毁 —— 同 §178.6 / §179.6 / §181.6 的取舍。
 *
 * @param value 要写的值
 * @returns 是否写成功
 */
export async function saveLibrary(value: unknown): Promise<boolean> {
  const current = await store.read();
  if (current.foreign) {
    console.error("[library] 磁盘上的本机库版本比本程序新，已拒绝覆盖：", current.note);
    return false;
  }

  const res = await store.write(asLibraryBlob(value));
  if (!res.ok) {
    // 原来写失败是一条日志都没有的，用户只会发现"装过的东西又没了"
    console.error("[library] 落盘失败（重试过）：", res.error);
  }
  return res.ok;
}

/**
 * 注册本机库 IPC。
 *
 * @param ipcMain Electron 的 ipcMain
 */
export function registerLibraryIpc(ipcMain: Electron.IpcMain): void {
  ipcMain.handle(LIBRARY_CHANNEL.load, (): Promise<unknown> => loadLibrary());
  ipcMain.handle(LIBRARY_CHANNEL.save, (_event, value: unknown): Promise<boolean> => saveLibrary(value));
}
