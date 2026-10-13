import { app } from "electron";
import path from "node:path";

import { normalizeLiked } from "../../shared/coding";
import { createJsonStore } from "./jsonStore";

/**
 * 「喜欢」的落盘（§180）。
 *
 * ## 为什么必须落盘
 *
 * §156 那次的教训：**localStorage 是懒刷的，硬杀进程就没了**。
 * 喜欢这种东西关掉窗口再打开就消失，用户会觉得"点了没用"。
 *
 * ## 形状
 *
 * `{"liked": ["应用名", ...]}` —— 只有名字，**没有点赞数**
 * （本体那个数字是跨用户热度，本机编不出来，详见 `shared/coding.ts`）。
 *
 * ── C1（2026-10-13）：落盘收进 `./jsonStore` ──
 *
 * 原来这个文件自己写了一遍"读 json / 写 json"（含 `mkdir` 与 `.tmp` + `rename` 原子写）。
 * 那份写法本身没错，毛病是它**没有写失败重试** —— Windows 上"文件被占用"大多是一次性冲突，
 * 不重试就等于把一次瞬时冲突记成"永久存不进去"，而用户看到的是"点了没用"。
 * 现在与其它几个库共用同一套落盘：原子写 + 写失败重试 3 次 + 信封带版本。
 *
 * ⚠️ 磁盘上现存的 `coding-likes.json` 是**裸 JSON**（没有信封）—— 它被读成"版本 0"并原样迁上来
 * （见 `shared/persist.ts` 里"版本 0 缺迁移 = 原样"那条默认），所以升级不会丢掉已点过的喜欢。
 * 归一化仍用 `normalizeLiked`：它同时认 `{liked: [...]}` 与裸数组两种形状，正好兜住这次变化。
 */

/** IPC 通道名（preload 与主进程共用）。 */
export const CODING_CHANNEL = {
  read: "coding:readLiked",
  write: "coding:writeLiked",
} as const;

/** 喜欢名单的文件路径。 */
export function codingLikesPath(): string {
  return path.join(app.getPath("userData"), "coding-likes.json");
}

/**
 * 落盘器（C1）。
 *
 * `file` 收的是**函数**而不是算好的路径：`app.getPath("userData")` 在打包前后不同，
 * 模块加载期求值会把第一次的结果锁死。归一化用 `normalizeLiked` ——
 * 读写走同一条归一化，磁盘上的东西一律当不可信（§178 那次的规矩）。
 */
const store = createJsonStore<{ liked: string[] }>({
  file: codingLikesPath,
  initial: () => ({ liked: [] }),
  normalize: (value) => ({ liked: normalizeLiked(value) }),
});

/**
 * 读喜欢名单。
 *
 * @returns 干净的名字列表；文件不存在或坏了都给空名单（**不让坏文件把应用卡住**）
 */
export async function loadLiked(): Promise<string[]> {
  const got = await store.read();
  // 读不动（磁盘上是更新的版本）只报一声：这里给的是兜底值，界面照常起得来
  if (got.foreign) console.error("[coding] 磁盘上的喜欢名单读不动（保留原样）：", got.note);
  return got.data.liked;
}

/**
 * 写喜欢名单（原子写由 `./jsonStore` 负责：先写 `.tmp` 再 rename）。
 *
 * ⚠️ 磁盘上是**更新的版本**时**拒绝覆盖**（`foreign`）：那是降级运行，
 * 硬写回去等于把用户的数据降级销毁 —— 与本项目 §178.6 / §179.6 / §181.6 同一条取舍。
 *
 * @param liked 名字列表
 * @returns 是否写成功
 */
export async function saveLiked(liked: unknown): Promise<boolean> {
  const next = { liked: normalizeLiked(liked) };

  const current = await store.read();
  if (current.foreign) {
    console.error("[coding] 磁盘上的喜欢名单版本比本程序新，已拒绝覆盖：", current.note);
    return false;
  }

  const res = await store.write(next);
  if (!res.ok) {
    // 原来写失败是一条日志都没有的，用户只会发现"重启后喜欢没了"
    console.error("[coding] 落盘失败（重试过）：", res.error);
  }
  return res.ok;
}

/**
 * 注册本机侧 IPC。
 *
 * @param ipc Electron 的 `ipcMain`
 */
export function registerCodingIpc(ipc: Electron.IpcMain): void {
  ipc.handle(CODING_CHANNEL.read, () => loadLiked());
  ipc.handle(CODING_CHANNEL.write, (_event, liked: unknown) => saveLiked(liked));
}
