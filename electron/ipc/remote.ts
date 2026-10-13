import { app, powerSaveBlocker } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

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

/** 读许可（默认 **true**：装好就能用，与实机默认一致）。 */
export async function loadAllowConnect(): Promise<boolean> {
  try {
    const raw = JSON.parse(await fs.readFile(settingsPath(), "utf8")) as { allowConnect?: unknown };
    return raw.allowConnect !== false;
  } catch {
    return true;
  }
}

/**
 * 写许可（原子写）。
 *
 * @param allow 是否允许被同账号设备连接
 * @returns 是否写成功
 */
export async function saveAllowConnect(allow: boolean): Promise<boolean> {
  const target = settingsPath();
  const temp = `${target}.tmp`;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temp, JSON.stringify({ allowConnect: allow }, null, 2), "utf8");
    await fs.rename(temp, target);
    return true;
  } catch {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    return false;
  }
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
