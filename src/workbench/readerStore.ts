import { create } from "zustand";
import type { ShellBridge } from "@shared/ipc";
import {
  normalizeReadings,
  readingTitle,
  type Reading,
  type ReaderTab,
} from "@shared/reader";

/**
 * AI 阅读的状态（§155）。
 *
 * ## 契约
 *
 * - 当前内容（`text`）**留在内存**：它可能是用户随手粘的一段东西，不该默默落盘；
 *   只有**显式收录的**才进「最近阅读」（`readings.json`）。
 * - 「最近阅读」以磁盘为准，读回时过 `normalizeReadings`。
 */

const bridge = (): ShellBridge | undefined => (globalThis as unknown as { shell?: ShellBridge }).shell;

let seq = 0;
const nextReadingId = (): string => {
  seq += 1;
  return `read_${Date.now().toString(36)}_${seq}`;
};

type ReaderState = {
  /** 正在读的内容（空串 = 空态）。 */
  text: string;
  /** 顶上显示的名字。 */
  title: string;
  /** 从「最近阅读」里打开的那一条（没打开过则为 null）。 */
  currentId: string | null;
  readings: Reading[];
  loaded: boolean;
  tab: ReaderTab;
  /** 侧栏是否展开（`copilot_hide_sidebar` = 隐藏侧栏）。 */
  sidebar: boolean;

  load: () => Promise<void>;
  /** 开始读一段新内容（不落盘）。 */
  open: (text: string, title?: string) => void;
  /** 把它收进「最近阅读」（落盘）。 */
  save: () => Promise<void>;
  openReading: (id: string) => void;
  removeReading: (id: string) => Promise<void>;
  setTab: (tab: ReaderTab) => void;
  toggleSidebar: () => void;
  clear: () => void;
};

export const useReaderStore = create<ReaderState>()((set, get) => {
  const persist = async (): Promise<void> => {
    const shell = bridge();
    if (!shell?.readings) return;
    try {
      await shell.readings.save(get().readings);
    } catch {
      /* 落盘失败不该把界面搅乱 */
    }
  };

  return {
    text: "",
    title: "",
    currentId: null,
    readings: [],
    loaded: false,
    tab: "outline",
    sidebar: true,

    load: async () => {
      const shell = bridge();
      if (!shell?.readings) {
        set({ loaded: true });
        return;
      }
      try {
        set({ readings: normalizeReadings(await shell.readings.load()), loaded: true });
      } catch {
        set({ loaded: true });
      }
    },

    open: (text, title) =>
      set({
        text,
        title: title ?? readingTitle(text),
        currentId: null,
      }),

    save: async () => {
      const { text, title, readings } = get();
      if (!text.trim()) return;
      const id = nextReadingId();
      const item: Reading = { id, title: title || readingTitle(text), text, at: Date.now() };
      // 同内容不重复收（用户点两下不该多两条）
      const dedup = readings.filter((r) => r.text !== text);
      set({ readings: normalizeReadings([item, ...dedup]), currentId: id });
      await persist();
    },

    openReading: (id) => {
      const item = get().readings.find((r) => r.id === id);
      if (!item) return;
      set({ text: item.text, title: item.title, currentId: id });
    },

    removeReading: async (id) => {
      set((s) => ({
        readings: s.readings.filter((r) => r.id !== id),
        currentId: s.currentId === id ? null : s.currentId,
      }));
      await persist();
    },

    setTab: (tab) => set({ tab }),
    toggleSidebar: () => set((s) => ({ sidebar: !s.sidebar })),
    clear: () => set({ text: "", title: "", currentId: null }),
  };
});
