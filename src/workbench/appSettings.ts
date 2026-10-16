import { create } from "zustand";
import type { ShellBridge } from "@shared/ipc";

/**
 * 本机版设置（§183）。
 *
 * 只有一项：**新对话默认模型**（`settings_defaultNewChatModel`）。
 * 空串 = 「记忆上次」（`settings_modelSelection_useLast`）。
 *
 * ⚠️ 走主进程落盘（不走 localStorage）：§156 那次"硬杀进程就没了"的教训。
 * 另外**读一次缓存在内存里** —— `resolveChatRoute()` 是同步被调的，
 * 不能每次都 await 一趟 IPC。
 */

const bridge = (): ShellBridge | undefined => (globalThis as unknown as { shell?: ShellBridge }).shell;

type State = {
  /** 钉住的默认通道（`provider/model`）；空串 = 记忆上次。 */
  pinnedModel: string;
  loaded: boolean;
  /** 上一次写盘的说明（成功为空串；失败时给一句人话，界面据此如实提示）。 */
  note: string;
  load: () => Promise<void>;
  setPinned: (value: string) => Promise<void>;
};

export const useAppSettings = create<State>()((set, get) => ({
  pinnedModel: "",
  loaded: false,
  note: "",

  load: async () => {
    const shell = bridge();
    if (!shell?.appSettings) {
      set({ loaded: true });
      return;
    }
    try {
      const got = await shell.appSettings.read();
      set({ pinnedModel: typeof got?.pinnedModel === "string" ? got.pinnedModel : "", loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  setPinned: async (value) => {
    const before = get().pinnedModel;
    set({ pinnedModel: value, note: "" });
    /*
     * ⚠️ **写盘失败要回滚**（2026-10-16 审计 P273）。
     *
     * 原来这里是 `await bridge()?.appSettings?.write({...})` —— 无 try/catch、也不回滚：
     * 调用点（`SettingsPages.tsx`）是 `void ...setPinned(...)`，于是 IPC 一拒绝
     * 就是一条**未处理的拒绝**；更要紧的是界面上已经显示新值而盘上还是旧值，
     * 用户以为钉住了，重启后**悄悄回到原来那个通道**。
     * 取舍与 `codingLikes.ts` 的 `toggle` 一致：失败就回到改动前那个值，并如实说一句。
     */
    try {
      await bridge()?.appSettings?.write({ pinnedModel: value });
    } catch (error) {
      set({
        pinnedModel: before,
        note: `没能存下这个默认模型：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  },
}));

/** 同步读一眼（给 `resolveChatRoute` 用）。 */
export function pinnedModelNow(): string {
  return useAppSettings.getState().pinnedModel;
}
