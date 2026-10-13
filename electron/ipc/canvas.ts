import { BrowserWindow, ipcMain } from "electron";
import {
  ackDocument,
  documentStatus,
  listRevisions,
  loadDocument,
  readRevision,
  restoreRevision,
  saveDocument,
} from "./snapshotStore";
import type { CanvasDocument } from "../../shared/canvas";
import type { CanvasCommand, CanvasCommandResult } from "../../shared/ipc";

/**
 * 持久化与版本历史 IPC（PLAN 4.2 / 4.3 / 4.5 + 版本历史面板）。
 *
 * 渲染进程只负责"把当前画布交出来"，磁盘上的原子性、确认、回退、回滚都在主进程做
 * （渲染进程崩了不能连带把文件写坏）。
 */

export const CANVAS_CHANNEL = {
  load: "canvas:load",
  save: "canvas:save",
  ack: "canvas:ack",
  status: "canvas:status",
  revisions: "canvas:revisions",
  readRevision: "canvas:readRevision",
  restore: "canvas:restore",
  /** 主进程 → 渲染进程：请求在画布上做点什么（§146）。 */
  command: "canvas:command",
  /** 渲染进程 → 主进程：做完了的回执。 */
  commandResult: "canvas:command-result",
} as const;

/**
 * 等回执的命令（id → 兑现函数）。
 *
 * 为什么是"发命令 + 等回执"而不是主进程直接改文档：
 * **画布文档由渲染进程持有**，主进程直接写会被渲染侧的自动保存覆盖掉。
 * 这与 §145 定时任务那条推送是同一个模式，只是这条需要**回执** ——
 * 工具得知道"到底加上了没有"，不然它只能猜。
 */
const pendingCommands = new Map<string, (result: CanvasCommandResult) => void>();

/**
 * 让渲染进程在画布上加一个节点。
 *
 * @param cmd 要加什么（不含 id，由这里生成）
 * @returns 渲染进程的回执；5 秒没回就当失败（并说清可能的原因）
 */
export function sendCanvasCommand(cmd: Omit<CanvasCommand, "id">): Promise<CanvasCommandResult> {
  return new Promise((resolve) => {
    const id = `cv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) {
      resolve({ id, ok: false, error: "没有可用窗口" });
      return;
    }
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      resolve({ id, ok: false, error: "画布没有在 5 秒内回执（可能窗口正在关闭）" });
    }, 5000);
    pendingCommands.set(id, (result) => {
      clearTimeout(timer);
      pendingCommands.delete(id);
      resolve(result);
    });
    win.webContents.send(CANVAS_CHANNEL.command, { id, ...cmd });
  });
}

export function registerCanvasIpc(): void {
  ipcMain.handle(CANVAS_CHANNEL.load, () => loadDocument());

  ipcMain.handle(CANVAS_CHANNEL.save, (_event, doc: CanvasDocument) => {
    if (!doc || typeof doc.revision !== "number" || !Array.isArray(doc.nodes)) {
      return { ok: false, error: "文档结构不合法：缺少 revision 或 nodes" };
    }
    return saveDocument(doc);
  });

  ipcMain.handle(CANVAS_CHANNEL.ack, (_event, revision: number) => ackDocument(Number(revision)));

  ipcMain.handle(CANVAS_CHANNEL.status, () => documentStatus());

  ipcMain.handle(CANVAS_CHANNEL.revisions, () => listRevisions());

  /** 读某个历史版本（用于预览）。 */
  ipcMain.handle(CANVAS_CHANNEL.readRevision, (_event, revision: number) =>
    readRevision(Number(revision)),
  );

  /** 回滚到某个历史版本（会写成一个新的、更大的修订号）。 */
  ipcMain.handle(CANVAS_CHANNEL.restore, (_event, revision: number) =>
    restoreRevision(Number(revision)),
  );

  /** 渲染进程执行完画布命令的回执（§146）。没人等就算了，不报错。 */
  ipcMain.handle(CANVAS_CHANNEL.commandResult, (_event, result: CanvasCommandResult) => {
    const id = result && typeof result.id === "string" ? result.id : "";
    pendingCommands.get(id)?.(result);
    return true;
  });
}
