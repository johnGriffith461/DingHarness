import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { useLibraryStore } from "./libraryStore";
import { useSearchHistoryStore } from "./searchHistoryStore";
import { useAppSettings } from "./appSettings";
import { clockOf } from "./duration";

/**
 * 第 5 单 sweep 尾巴里"store / 接线那一族"的判据（2026-10-16）：
 *   P262 存盘失败的提示没人读；P263 载入没完成就写盘（会把空库盖上去）；
 *   P264 `libraryStore.load` 没有 try/catch（IPC 一拒绝就是未处理拒绝 + 永远没载入）；
 *   P271 搜索历史落盘没有排队（两次快写可能乱序、少一条）；
 *   P273 `setPinned` 写盘失败不回滚（界面显示新值而盘上还是旧值）；
 *   P275 方向键被算成"键盘导航"（鼠标用户按一下又把描边点亮）；
 *   P265 第二份 `formatBytes`（同一个文件两种体积）；
 *   P10  `shell!` 非空断言（没有桥就抛 TypeError）；P262/P251 读 note。
 */

const ROOT = path.resolve(__dirname, "..", "..");
function source(rel: string): string {
  const text = readFileSync(path.join(ROOT, rel), "utf8");
  return text.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 极简假桥：只给这次要用的那几个通道。 */
function installShell(parts: Record<string, unknown>): void {
  (globalThis as unknown as { shell?: unknown }).shell = parts;
}

describe("P263 / P264：本机库的载入与写盘", () => {
  beforeEach(() => {
    useLibraryStore.setState({ loaded: false, note: "", lib: { ...useLibraryStore.getState().lib } });
  });

  it("⭐ 载入没完成时**不许写盘**（否则一次点击把磁盘上的库盖成空的）", async () => {
    const writes: unknown[] = [];
    /* 载入"还没回来"（用一个永不 resolve 的 Promise 模拟） */
    installShell({
      library: {
        load: () => new Promise(() => undefined),
        save: async (lib: unknown) => {
          writes.push(lib);
          return true;
        },
      },
    });
    void useLibraryStore.getState().load([]);
    useLibraryStore.getState().install("some-id");
    /* 写盘是排队异步的：要给它一拍才能看见"到底发出去没有" */
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(writes, "载入完成前的写盘请求不该发出去（那是拿内存里的空库盖磁盘）").toHaveLength(0);
  });

  it("⭐ 载入 IPC 拒绝时：不抛未处理拒绝，`loaded` 落成 true 并如实说一句（P264）", async () => {
    installShell({
      library: {
        load: async () => {
          throw new Error("文件比本代码新");
        },
        save: async () => true,
      },
    });
    await useLibraryStore.getState().load([]);
    const state = useLibraryStore.getState();
    expect(state.loaded, "IPC 一拒绝就永远停在 loaded:false —— 后面每次操作都落在「没载入」那一档").toBe(true);
    expect(state.note).toContain("没读出来");
  });

  it("载入完成后，载入期间的改动会被真正写出去（不丢用户那一下）", async () => {
    const writes: unknown[] = [];
    let release: () => void = () => undefined;
    installShell({
      library: {
        load: () =>
          new Promise((resolve) => {
            release = () => resolve({ installed: [], enabled: [], pinned: [], starred: [], projects: [], custom: [] });
          }),
        save: async (lib: unknown) => {
          writes.push(lib);
          return true;
        },
      },
    });
    const loading = useLibraryStore.getState().load([]);
    useLibraryStore.getState().pin("t1");
    release();
    await loading;
    await Promise.resolve();
    expect(writes.length, "载入期间点的那一下没有补写出去").toBeGreaterThan(0);
  });
});

describe("P271：搜索历史落盘要排队", () => {
  it("⭐ 源码里必须有串行化的 saveQueue（两次快写不许并发）", () => {
    const src = source("src/workbench/searchHistoryStore.ts");
    expect(src, "又回到了「每次立刻 save」—— 旧快照可能后落地，历史里少一条").toContain("saveQueue");
  });

  it("行为：两次快速记录都写出去了，而且**串行**（第二次不会与第一次同时落在盘上）", async () => {
    const saves: unknown[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    installShell({
      searchHistory: {
        load: async () => ({ skills: [], files: [] }),
        save: async (h: unknown) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          /* 慢一点：不串行的话两次写会重叠（真实磁盘也是这么慢） */
          await new Promise((r) => setTimeout(r, 5));
          saves.push(JSON.parse(JSON.stringify(h)));
          inFlight -= 1;
          return true;
        },
      },
    });
    useSearchHistoryStore.setState({ history: { skills: [], files: [] }, loaded: true });
    useSearchHistoryStore.getState().record("skills", "第一");
    useSearchHistoryStore.getState().record("skills", "第二");
    /* 排队的写盘是异步的，给它几拍 */
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(saves.length, "两次记录该各写一次（排队而不是丢弃）").toBe(2);
    expect(maxInFlight, "两次写盘重叠了 —— 落盘顺序不保证，旧快照可能后落地（P271）").toBe(1);
    const last = saves[saves.length - 1] as { skills: string[] };
    /* 最近的在最前（`shared/searchHistory.ts` 的 `pushHistory` 就是这个顺序） */
    expect(last.skills[0]).toBe("第二");
    expect(last.skills).toContain("第一");
  });
});

describe("P273：默认模型写盘失败要回滚", () => {
  it("⭐ 写盘 reject → 回到改动前的值，并留下一句说明", async () => {
    useAppSettings.setState({ pinnedModel: "旧通道/x", note: "" });
    installShell({
      appSettings: {
        write: async () => {
          throw new Error("磁盘只读");
        },
      },
    });
    await useAppSettings.getState().setPinned("新通道/y");
    const state = useAppSettings.getState();
    expect(state.pinnedModel, "界面显示新值而盘上还是旧值 —— 用户以为钉住了，重启后悄悄回退").toBe("旧通道/x");
    expect(state.note).toContain("没能存下");
  });

  it("写成功就留着新值、不留提示", async () => {
    useAppSettings.setState({ pinnedModel: "", note: "" });
    installShell({ appSettings: { write: async () => undefined } });
    await useAppSettings.getState().setPinned("a/b");
    expect(useAppSettings.getState().pinnedModel).toBe("a/b");
    expect(useAppSettings.getState().note).toBe("");
  });
});

describe("P275：方向键不算「键盘导航」", () => {
  it("⭐ 只有 Tab 允许置位 `data-kb`", () => {
    const src = source("src/workbench/inputModality.ts");
    expect(src, "方向键又被算进来了 —— 鼠标点进输入框后按一下 ↑ 就把「雷霆大描边」点亮").not.toMatch(
      /startsWith\("Arrow"\)/,
    );
    expect(src).toMatch(/e\.key === "Tab"/);
  });
});

describe("P265：体积只有一份实现", () => {
  it("⭐ `uiUtil.formatBytes` 转发到 `@shared/drive`（同一个文件两个界面同一句话）", async () => {
    const { formatBytes } = await import("./uiUtil");
    const { formatBytes: canonical } = await import("@shared/drive");
    for (const bytes of [0, 999, 1024, 1536 * 1024, 1.5 * 1024 ** 3, Number.NaN, -5]) {
      expect(formatBytes(bytes), `${bytes} 两个实现又不一样了`).toBe(canonical(bytes));
    }
    expect(formatBytes(1.5 * 1024 ** 3), "1.5GB 要说 GB，不是 1536.0 MB").toBe("1.50 GB");
    expect(formatBytes(Number.NaN), "非法值不许输出 NaN B").toBe("0 B");
  });
});

describe("P10 / P262 / P251 / P256：说清楚，别静默", () => {
  it("⭐ 插件页不再有 `shell!` 非空断言（没有桥时抛 TypeError，界面什么都不说）", () => {
    const src = source("src/workbench/PluginsPage.tsx");
    expect(src, "`shell!.plugins.x` 又回来了：无桥环境点一下安装直接抛").not.toMatch(/shell!\./);
    const unchecked = source("src/workbench/PluginsPage.tsx");
    expect(unchecked, "要有一处把「没有桥」说出来的出口").toContain("插件通道不可用");
  });

  it("⭐ 本机库的 note 有人读了（P262：原来全仓零命中）", () => {
    const src = source("src/workbench/PluginsPage.tsx");
    expect(src, "写进 note 却没人显示 —— 存盘失败在界面上完全隐形").toMatch(/useLibraryStore\(\(s\) => s\.note\)/);
  });

  it("⭐ 记忆面板读 note（P251）", () => {
    const src = source("src/workbench/MemoryPanel.tsx");
    expect(src, "落盘失败只写 note，面板不读 = 用户以为记下了").toMatch(/note/);
    expect(src).toContain("wb-memory-note");
  });

  it("⭐ 双击最大化键不许连发三次 toggleMaximize（P109）", () => {
    const src = source("src/workbench/TitleBar.tsx");
    expect(src, "标题栏的双击又会对按钮区生效了 —— 一次手势三次请求，窗口走「最大化→还原→最大化」").toContain(
      'closest(".wb-winctl")',
    );
  });

  it("⭐ 图片动作要把主进程那句 inputNote 带出来（P256）", () => {
    const src = source("src/workbench/ImageActionBar.tsx");
    expect(src, "`got.inputNote` 被丢掉了 —— 输入图被规整过这件事没有任何出口").toContain("got.inputNote");
  });
});

describe("P272 的另一半：时长文案只此一处", () => {
  it("UsagePopover 不再自己算分秒（用 clockOf）", () => {
    const src = source("src/workbench/UsagePopover.tsx");
    expect(src, "又回到「分钟与秒各算各的」—— 会出现 0:60").toContain("clockOf(");
    expect(src).not.toMatch(/Math\.round\(seconds % 60\)/);
  });

  it("clockOf 本身在（免得上面那条断言只是找了个别名）", () => {
    expect(clockOf(59.6)).toBe("1:00");
  });
});
