import { app, powerSaveBlocker } from "electron";
import path from "node:path";

import { createJsonStore } from "./jsonStore";

/**
 * 远端控制的本机侧状态（阶段 11.26）。
 *
 * ## 为什么「保持唤醒」要放在主进程
 * 它**不是偏好设置，是这台机器当前的真实状态** —— 用户关掉开关之前，
 * 屏幕就不该灭。所以它必须落在一个真的会拦住休眠的地方（`powerSaveBlocker`），
 * 而不是渲染进程里一个 useState（那个重启就没了，用户会以为"设了没用"）。
 *
 * ## 为什么「可被同账号设备连接与控制」是个持久化的许可
 * 它是**许可**：关掉之后别的设备就不该能连上。许可要跨重启生效，
 * 所以存盘（放在本机库同一个文件里，理由见下）。
 *
 * ── C1（2026-10-13）：许可的落盘收进 `./jsonStore` ──
 *
 * 与 `appSettings` 一样原本已是异步原子写，但**不重试、无版本**。收进来之后强度一致。
 * ⚠️ **默认值必须保住**：许可缺省是 `true`（装好就能用，与实机默认一致）——
 * 文件不存在、读坏了、字段缺失，**都算 true**，不能变成"默认拒绝"。
 */

/** 通道名。 */
export const REMOTE_CHANNEL = {
  /** 读当前状态：许可 + 是否正在阻止休眠。 */
  status: "remote:status",
  /** 开关"保持唤醒"（真的调 powerSaveBlocker）。 */
  setKeepAwake: "remote:setKeepAwake",
  /** 开关"可被同账号设备连接与控制"（写盘）。 */
  setAllowConnect: "remote:setAllowConnect",
} as const;

/** 许可存在哪个文件（与图像生成、产物等一起落在 userData 下）。 */
function settingsPath(): string {
  return path.join(app.getPath("userData"), "remote.json");
}

/** 当前阻止休眠的 blocker id；null 表示没开。 */
let blockerId: number | null = null;

/**
 * 许可落盘器（C1：与其余 store 同一条路）。
 *
 * ⚠️ `normalize` 里那句 `!== false` 是**默认值本身**：只有明确写进去的 `false` 才算"关"，
 * 其余一切（字段缺失、老文件、坏值）都是 `true`。改成 `=== true` 就把默认语义反过来了。
 */
const store = createJsonStore<{ allowConnect: boolean }>({
  file: settingsPath,
  initial: () => ({ allowConnect: true }),
  normalize: (value) => ({ allowConnect: (value as { allowConnect?: unknown } | null)?.allowConnect !== false }),
});

/** 读许可（默认 **true**：装好就能用，与实机默认一致）。 */
export async function loadAllowConnect(): Promise<boolean> {
  const got = await store.read();
  // 读不动（磁盘上是更新的版本）只报一声：这里给的是默认许可，界面照常起得来
  if (got.foreign) console.error("[remote] 磁盘上的远端许可读不动（保留原样）：", got.note);
  return got.data.allowConnect;
}

/**
 * 写许可（原子写由 `./jsonStore` 负责）。
 *
 * ⚠️ 磁盘上是**更新的版本**时**拒绝覆盖**（`foreign`）：那是降级运行，
 * 硬写回去等于把用户的许可降级销毁 —— 同 §178.6 / §179.6 / §181.6 的取舍。
 *
 * @param allow 是否允许被同账号设备连接
 * @returns 是否写成功
 */
export async function saveAllowConnect(allow: boolean): Promise<boolean> {
  const current = await store.read();
  if (current.foreign) {
    console.error("[remote] 磁盘上的远端许可版本比本程序新，已拒绝覆盖：", current.note);
    return false;
  }

  const res = await store.write({ allowConnect: allow });
  if (!res.ok) {
    // 原来这里也是静默 catch 的，表现是"关了许可、重启又开了"
    console.error("[remote] 落盘失败（重试过）：", res.error);
  }
  return res.ok;
}

/** 是否正在阻止休眠（以 blocker 的实时状态为准，不信渲染进程的记忆）。 */
export function isKeepingAwake(): boolean {
  return blockerId !== null && powerSaveBlocker.isStarted(blockerId);
}

/**
 * 开关"保持唤醒"。
 *
 * @param on 是否保持唤醒
 * @returns 操作后的真实状态
 */
export function setKeepAwake(on: boolean): boolean {
  if (on) {
    if (!isKeepingAwake()) {
      /*
       * `prevent-display-sleep` 而不是 `prevent-app-suspension`：
       * 前者保持**屏幕**常亮（远程看画面需要），后者只阻止应用挂起。
       */
      blockerId = powerSaveBlocker.start("prevent-display-sleep");
    }
    return true;
  }
  if (blockerId !== null) {
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
  return false;
}

/**
 * 注册远端控制 IPC。
 *
 * @param ipcMainInstance Electron 的 ipcMain
 */
export function registerRemoteIpc(ipcMainInstance: Electron.IpcMain): void {
  ipcMainInstance.handle(REMOTE_CHANNEL.status, async () => ({
    allowConnect: await loadAllowConnect(),
    keepAwake: isKeepingAwake(),
  }));
  ipcMainInstance.handle(REMOTE_CHANNEL.setKeepAwake, (_event, on: boolean) => setKeepAwake(Boolean(on)));
  ipcMainInstance.handle(REMOTE_CHANNEL.setAllowConnect, (_event, on: boolean) => saveAllowConnect(Boolean(on)));
}
