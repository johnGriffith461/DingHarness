import { create } from "zustand";

import { addMemory, clearMemory, EMPTY_MEMORY, removeMemory, type MemoryEntry, type MemoryLib } from "@shared/memory";
import type { ShellBridge } from "@shared/ipc";

/**
 * 「记忆」的渲染进程 store。
 *
 * 与 `driveStore` / `scheduleStore` 同一个形态：**先改本地、再落盘**，
 * 让点击立刻有反馈；落盘失败只记 note，不把界面回滚（回滚会让用户以为没点上）。
 */

/*
 * ⚠️ 这里原来有一个 `MemoryBridge = ShellBridge & { memory?: {…} }` 的**补丁类型** ——
 * 因为 `memory` 只被 preload 暴露、契约 `ShellBridge` 里没有（手册点名的两处漂移之一）。
 * C4 把 `memory` 补进契约、并让 preload `satisfies ShellBridge` 之后，补丁就不需要了：
 * **契约是唯一的事实来源**，这边直接用 `ShellBridge["memory"]`。
 */

type MemoryState = {
  /** 当前记忆库。 */
  lib: MemoryLib;
  /** 是否已从磁盘读过一次。 */
  loaded: boolean;
  /** 上一次落盘的问题（有值时界面可以如实显示）。 */
  note: string;
  /**
   * 读一次。
   *
   * @returns 读完后 resolve
   */
  load: () => Promise<void>;
  /**
   * 加一条。
   *
   * @param text 正文
   * @param source 来源
   * @param fromTask 来自哪次对话
   * @returns 加完后 resolve
   */
  add: (text: string, source?: MemoryEntry["source"], fromTask?: string) => Promise<void>;
  /**
   * 删一条。
   *
   * @param id 条目 id
   * @returns 删完后 resolve
   */
  drop: (id: string) => Promise<void>;
  /**
   * 清空。
   *
   * @returns 清完后 resolve
   */
  clear: () => Promise<void>;
  /**
   * 记忆开关（§182，设置里的「记忆」）。
   *
   * @param on 开着没有
   */
  setEnabled: (on: boolean) => Promise<void>;
};

/**
 * 取 bridge。
 *
 * @returns preload 暴露的 memory，取不到则为 undefined（跑测试时就是这样）
 */
function bridge(): ShellBridge["memory"] | undefined {
  return (globalThis as { shell?: ShellBridge }).shell?.memory;
}

/**
 * 落盘一次。
 *
 * @param lib 要写的库
 * @returns 出错时的说明，成功则为空串
 */
async function persist(lib: MemoryLib): Promise<string> {
  const b = bridge();
  if (!b) return "没有主进程通道（测试环境属正常）";
  try {
    await b.write(lib);
    return "";
  } catch (e) {
    return `保存失败：${String(e).slice(0, 60)}`;
  }
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  lib: EMPTY_MEMORY,
  loaded: false,
  note: "",

  load: async () => {
    const b = bridge();
    if (!b) {
      set({ loaded: true });
      return;
    }
    try {
      const raw = await b.read();
      set({ lib: raw as MemoryLib, loaded: true, note: "" });
    } catch (e) {
      set({ loaded: true, note: `读取失败：${String(e).slice(0, 60)}` });
    }
  },

  add: async (text, source, fromTask) => {
    const next = addMemory(get().lib, text, { ...(source ? { source } : {}), ...(fromTask ? { fromTask } : {}) });
    if (next === get().lib) return; // 空白或重复，没变化
    set({ lib: next });
    set({ note: await persist(next) });
  },

  drop: async (id) => {
    const next = removeMemory(get().lib, id);
    set({ lib: next });
    set({ note: await persist(next) });
  },

  setEnabled: async (on) => {
    const next = { ...get().lib, enabled: on };
    set({ lib: next });
    /*
     * 落盘：开关状态也要活过重启。
     * 不落盘的话，用户关掉记忆、"重启又开回来" —— 那个开关就成了摆设
     * （与 §182 在 `normalizeMemory` 里保住 `enabled` 是同一件事的两半）。
     */
    set({ note: await persist(next) });
  },

  clear: async () => {
    const next = clearMemory();
    set({ lib: next });
    const b = bridge();
    set({ note: b ? await (async () => {
      try {
        await b.clear();
        return "";
      } catch (e) {
        return `清除失败：${String(e).slice(0, 60)}`;
      }
    })() : "" });
  },
}));
