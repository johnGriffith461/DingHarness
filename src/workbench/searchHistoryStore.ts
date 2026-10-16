import { create } from "zustand";
import type { ShellBridge } from "@shared/ipc";
import {
  emptyHistory,
  normalizeHistory,
  pushHistory,
  removeHistory,
  type HistoryScope,
  type SearchHistory,
} from "@shared/searchHistory";

/**
 * 搜索历史的状态（§162）。
 *
 * ## 契约
 *
 * - 磁盘是权威：启动 `load()` 一次；
 * - `record(scope, query)` 会**立刻落盘**（搜索历史是用户觉得"一直在"的东西，
 *   攒着不写会在强杀时丢 —— §156 的教训）；
 * - 落盘失败不影响界面（记在内存里，这一轮仍可用）。
 */

const bridge = (): ShellBridge | undefined => (globalThis as unknown as { shell?: ShellBridge }).shell;

type State = {
  history: SearchHistory;
  loaded: boolean;

  load: () => Promise<void>;
  /** 记一条（在哪搜的 + 搜的什么）。 */
  record: (scope: HistoryScope, query: string) => void;
  /** 去掉某一条。 */
  forget: (scope: HistoryScope, query: string) => void;
  /** 清空某个范围的全部记录。 */
  clear: (scope: HistoryScope) => void;
  /** 清空两个范围（对应证据里那句「清空全部搜索记录」）。 */
  clearAll: () => void;
};

export const useSearchHistoryStore = create<State>()((set, get) => {
  /*
   * 串行化写盘（2026-10-16 审计 P271）。
   *
   * 原来 `record` 每次都**立刻** `shell.searchHistory.save(...)`，而主进程那次写是 async
   * 且带退避重试 —— 两次快速搜索（第二次在第一次还没写完时发生）的落盘顺序**不保证**
   * 与调用顺序一致，于是旧快照可能后落地：历史里**少一条**（内存里还显示两条，
   * 下次重启才发现）。同仓 `libraryStore.ts` 为这件事专门写了 `saveQueue`，这里照办。
   */
  let saveQueue: Promise<unknown> = Promise.resolve();
  const persist = (): void => {
    const shell = bridge();
    if (!shell?.searchHistory) return;
    saveQueue = saveQueue
      .then(() => shell.searchHistory.save(get().history))
      .catch(() => undefined);
  };

  return {
    history: emptyHistory(),
    loaded: false,

    load: async () => {
      const shell = bridge();
      if (!shell?.searchHistory) {
        set({ loaded: true });
        return;
      }
      try {
        set({ history: normalizeHistory(await shell.searchHistory.load()), loaded: true });
      } catch {
        set({ loaded: true });
      }
    },

    record: (scope, query) => {
      const next = pushHistory(get().history[scope] ?? [], query);
      set({ history: { ...get().history, [scope]: next } });
      persist();
    },

    forget: (scope, query) => {
      set({ history: { ...get().history, [scope]: removeHistory(get().history[scope] ?? [], query) } });
      persist();
    },

    clear: (scope) => {
      set({ history: { ...get().history, [scope]: [] } });
      persist();
    },

    clearAll: () => {
      set({ history: emptyHistory() });
      persist();
    },
  };
});
