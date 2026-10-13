import { create } from "zustand";
import type { ShellBridge } from "@shared/ipc";
import { isLiked, toggleLiked } from "@shared/coding";

/**
 * 「喜欢」的状态（§180）。
 *
 * ## 为什么要落盘 + 为什么要过主进程
 *
 * §156 那次的教训：**localStorage 是懒刷的，硬杀进程就没了**。
 * 喜欢这种东西关掉窗口再打开就消失，用户会觉得"点了没用"。
 *
 * ## 为什么没有点赞数
 *
 * 本体卡片上那个数字是**跨用户**的热度。本机只有你自己，
 * 编一个数字就是造假数据（与排行那条同一条规矩：排不出来就写在界面上）。
 */

const bridge = (): ShellBridge | undefined => (globalThis as unknown as { shell?: ShellBridge }).shell;

type State = {
  liked: string[];
  loaded: boolean;
  /** 读一次（开机调）。 */
  load: () => Promise<void>;
  /** 切换喜欢并落盘。 */
  toggle: (name: string) => Promise<void>;
};

export const useCodingLikes = create<State>()((set, get) => ({
  liked: [],
  loaded: false,

  load: async () => {
    const shell = bridge();
    if (!shell?.coding) {
      set({ loaded: true });
      return;
    }
    try {
      const liked = await shell.coding.loadLiked();
      set({ liked: Array.isArray(liked) ? liked : [], loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  toggle: async (name) => {
    const next = toggleLiked(get().liked, name);
    // 先改界面再落盘：点了立刻有反馈；写失败下次读回来会纠正
    set({ liked: next });
    await bridge()?.coding?.saveLiked(next);
  },
}));

/** 某个应用喜不喜欢（界面据此决定按钮那句话）。 */
export function likedHere(liked: readonly string[], name: string): boolean {
  return isLiked(liked, name);
}
