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
  load: () => Promise<void>;
  setPinned: (value: string) => Promise<void>;
};

export const useAppSettings = create<State>()((set) => ({
  pinnedModel: "",
  loaded: false,

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
    set({ pinnedModel: value });
    await bridge()?.appSettings?.write({ pinnedModel: value });
  },
}));

/** 同步读一眼（给 `resolveChatRoute` 用）。 */
export function pinnedModelNow(): string {
  return useAppSettings.getState().pinnedModel;
}
