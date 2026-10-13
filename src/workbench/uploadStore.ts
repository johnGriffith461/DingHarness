import { create } from "zustand";
import type { ShellBridge } from "@shared/ipc";
import {
  UPLOAD_REASON_LABEL,
  shouldShowPanel,
  summarize,
  toTasks,
  type ImportItem,
  type UploadFailReason,
  type UploadTask,
} from "@shared/upload";

/**
 * 上传任务的状态（§170）。
 *
 * ## 契约
 *
 * - 任务列表**只在内存里**（一次上传是"此刻正在做的事"，不是长期数据）；
 * - `start()` 先把所有任务标成**正在上传**（用户点了立刻有反馈），
 *   拿到结果再逐条落成 **已完成 / 解析失败**；
 * - 面板的显示与否由 `shouldShowPanel` 决定（没有任务就不占地方）。
 */

const bridge = (): ShellBridge | undefined => (globalThis as unknown as { shell?: ShellBridge }).shell;

/** 把主进程给的 reason（字符串）收窄成联合类型。 */
function narrow(items: Array<{ name: string; ok: boolean; reason?: string; savedAs?: string }>): ImportItem[] {
  return items.map((x) => ({
    name: x.name,
    ok: x.ok,
    ...(x.savedAs ? { savedAs: x.savedAs } : {}),
    ...(x.reason && x.reason in UPLOAD_REASON_LABEL
      ? { reason: x.reason as UploadFailReason }
      : x.reason
        ? { reason: "parseFail" as UploadFailReason }
        : {}),
  }));
}

type State = {
  tasks: UploadTask[];
  /** 正在上传（用来禁用按钮、避免并发导入）。 */
  busy: boolean;
  /** 面板是不是收起的（对应 `drive_upload_tooltip_hideWindow`）。 */
  collapsed: boolean;

  /** 从一批路径导入（拖拽有路径时 / 批量用）。 */
  startPaths: (paths: string[]) => Promise<void>;
  /**
   * 从拖进来的 `File` 导入（§171）。
   *
   * 走**内容**那条路（`importData`）：拖进来的东西不一定拿得到磁盘路径，
   * 但有内容就够了。
   */
  startFiles: (files: File[]) => Promise<void>;
  /** 弹系统选择框导入（「上传」按钮用）。 */
  startDialog: () => Promise<void>;
  toggleCollapsed: () => void;
  /** 关掉面板（`drive_upload_tooltip_close`）。 */
  clear: () => void;
};

export const useUploadStore = create<State>()((set, get) => ({
  tasks: [],
  busy: false,
  collapsed: false,

  startPaths: async (paths) => {
    if (get().busy || paths.length === 0) return;
    // 先把它们都摆成"正在上传"：点了立刻有反馈，而不是等结果回来才出现
    set({
      busy: true,
      collapsed: false,
      tasks: paths.map((p) => ({
        name: p.split(/[\\/]/).pop() ?? p,
        ok: true,
        status: "uploading" as const,
      })),
    });
    try {
      const got = await bridge()?.drive?.importPaths(paths);
      set({ tasks: toTasks(narrow(got?.items ?? [])) });
    } catch {
      set({
        tasks: paths.map((p) => ({
          name: p.split(/[\\/]/).pop() ?? p,
          ok: false,
          status: "failed" as const,
          reason: "parseFail" as const,
        })),
      });
    } finally {
      set({ busy: false });
    }
  },

  startFiles: async (files) => {
    if (get().busy || files.length === 0) return;
    set({
      busy: true,
      collapsed: false,
      tasks: files.map((f) => ({ name: f.name, ok: true, status: "uploading" as const })),
    });
    try {
      /*
       * 先把内容全读出来再发一次 IPC。
       * 一个一个发会变成 N 次往返，而且面板会闪来闪去；
       * 拖进来的都是用户手选的几个文件，一次读齐不难。
       */
      const payload: Array<{ name: string; data: Uint8Array }> = [];
      for (const f of files) {
        payload.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
      }
      const got = await bridge()?.drive?.importData(payload);
      set({ tasks: toTasks(narrow(got?.items ?? [])) });
    } catch {
      set({
        tasks: files.map((f) => ({
          name: f.name,
          ok: false,
          status: "failed" as const,
          reason: "parseFail" as const,
        })),
      });
    } finally {
      set({ busy: false });
    }
  },

  startDialog: async () => {    if (get().busy) return;
    const shell = bridge();
    if (!shell?.drive) return;
    set({ busy: true, collapsed: false });
    try {
      const got = await shell.drive.importFiles();
      if (got.items.length > 0) set({ tasks: toTasks(narrow(got.items)) });
    } catch {
      /* 对话框那一步失败就不留痕迹（用户什么都还没选） */
    } finally {
      set({ busy: false });
    }
  },

  toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
  clear: () => set({ tasks: [] }),
}));

/** 面板上的汇总那句（证据 `drive_upload_status_sum`）。 */
export function uploadSummary(tasks: readonly UploadTask[]): string {
  return summarize(tasks);
}

export { shouldShowPanel };
