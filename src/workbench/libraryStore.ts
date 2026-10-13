import { create } from "zustand";
import type { ShellBridge } from "@shared/ipc";
import {
  addCustom,
  createProject,
  EMPTY_LIBRARY,
  normalizeLibrary,
  removeCustom,
  removeProject,
  renameProject,
  setProjectMember,
  toggleEnabled,
  toggleInstalled,
  togglePinned,
  type Library,
  type Project,
} from "@shared/library";
import { CATALOG_IDS, findItem } from "./catalog";

/**
 * 本机库（阶段 11.7 / 11.8）：装过的插件、项目、置顶、收藏。
 *
 * ## 收窄放在这一层，不在主进程
 * `normalizeLibrary` 要拿两份外部集合：**目录里现有的 id**（剔除下架的条目）
 * 和**当前活着的任务 id**（剔除悬空的项目成员/置顶项）。
 * 这两样只有渲染层清楚，所以主进程只负责读写字节。
 *
 * ## 写盘是"每次都整份写"
 * 库很小（几 KB），整份写最简单也最不容易出不一致。用 `saveQueue` 串起来 ——
 * 连点两次「安装」如果两次写并发，后一次可能覆盖前一次的结果。
 */

type LibraryState = {
  lib: Library;
  loaded: boolean;
  note: string;

  /** 从磁盘载入并按当前目录收窄。`taskIds` 为已恢复的任务 id（空数组表示确实没有任务）。 */
  load: (taskIds?: string[]) => Promise<void>;
  /** 安装 / 卸载。 */
  install: (id: string) => void;
  /** 启用 / 停用（只有装过的能启用）。 */
  enable: (id: string) => void;
  /** 新建项目。返回错误说明；成功返回 null。 */
  addProject: (name: string) => string | null;
  rename: (id: string, name: string) => void;
  dropProject: (id: string) => void;
  /** 把任务放进项目（null 表示移出所有项目）。 */
  assignProject: (projectId: string | null, taskId: string) => void;
  /** 置顶 / 取消置顶任务。 */
  pin: (taskId: string) => void;
  /** 收藏 / 取消收藏云盘文件。 */
  star: (fileName: string) => void;
  /** 加一条自定义能力（对标插件页的「添加」）。返回错误说明；成功返回 null。 */
  addCustomItem: (name: string, hint: string, type: "plugin" | "skill") => string | null;
  /** 删掉一条自定义能力（同时从装/启用里清掉）。 */
  dropCustomItem: (id: string) => void;
};

/** 取 shell 桥。 */
function bridge(): ShellBridge | undefined {
  return (globalThis as unknown as { shell?: ShellBridge }).shell;
}

let seq = 0;

/** 串行化写盘：避免并发写互相覆盖。 */
let saveQueue: Promise<unknown> = Promise.resolve();

/**
 * 落盘。
 *
 * @param lib 要写的库
 * @returns 写完的 Promise（串在上一次之后）
 */
function persist(lib: Library): void {
  const shell = bridge();
  if (!shell?.library) return;
  saveQueue = saveQueue
    .then(() => shell.library.save(lib))
    .then((ok) => {
      if (!ok) useLibraryStore.setState({ note: "改动已生效，但存盘失败（重启后可能丢失）" });
    })
    .catch(() => undefined);
}

/** 统一的"改一下再存"入口。 */
function update(derive: (lib: Library) => Library): void {
  const next = derive(useLibraryStore.getState().lib);
  useLibraryStore.setState({ lib: next });
  persist(next);
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  lib: EMPTY_LIBRARY,
  loaded: false,
  note: "",

  load: async (taskIds) => {
    const shell = bridge();
    if (!shell?.library) {
      set({ loaded: true });
      return;
    }
    const raw = await shell.library.load();
    /*
     * 任务集合**已知**时才剔悬空项。
     *
     * 任务现在会持久化（阶段 11.9），所以调用方在恢复完任务之后才调这里；
     * 此时空数组意味着"确实一个任务都没有"，照常剔掉悬空的置顶与项目成员是对的。
     * 但**未传**（undefined）表示调用方还没准备好 —— 那种情况不剔，
     * 否则会把用户的项目与置顶清空一遍。
     */
    const lib = normalizeLibrary(raw, CATALOG_IDS, taskIds ? new Set(taskIds) : null);
    set({ lib, loaded: true });
    persist(lib);
  },

  install: (id) => update((lib) => toggleInstalled(lib, id)),
  enable: (id) => update((lib) => toggleEnabled(lib, id)),

  addProject: (name) => {
    const clean = name.trim();
    if (!clean) return "给项目起个名字";
    if (get().lib.projects.some((p) => p.name === clean)) return "已经有同名项目了";
    update((lib) => createProject(lib, `proj${Date.now().toString(36)}${(seq += 1)}`, clean, Date.now()));
    return null;
  },

  rename: (id, name) => update((lib) => renameProject(lib, id, name)),
  dropProject: (id) => update((lib) => removeProject(lib, id)),
  assignProject: (projectId, taskId) => update((lib) => setProjectMember(lib, projectId, taskId)),
  pin: (taskId) => update((lib) => togglePinned(lib, taskId)),

  star: (fileName) =>
    update((lib) => ({
      ...lib,
      starredFiles: lib.starredFiles.includes(fileName)
        ? lib.starredFiles.filter((x) => x !== fileName)
        : [...lib.starredFiles, fileName],
    })),

  addCustomItem: (name, hint, type) => {
    if (!name.trim()) return "给它起个名字";
    if (!hint.trim()) return "写一句它是干什么的（这句会进任务的提示词）";
    if (get().lib.custom.some((c) => c.name === name.trim())) return "已经有同名的了";
    const item = { id: `cu${Date.now().toString(36)}${(seq += 1)}`, name, hint, type };
    update((lib) => addCustom(lib, item));
    // 加完顺手装上并启用 —— 用户加一条就是为了用它，
    // 还要再去点两次「安装」「启用」是多余的
    update((lib) => toggleEnabled(toggleInstalled(lib, item.id), item.id));
    return null;
  },

  dropCustomItem: (id) => update((lib) => removeCustom(lib, id)),
}));

/** 便于别处直接取项目（避免每次 select 都新建数组）。 */
export function projectOf(projects: Project[], taskId: string): Project | undefined {
  return projects.find((p) => p.memberIds.includes(taskId));
}

/**
 * 按 id 找一条能力，**自定义的优先**。
 *
 * ⚠️ 这是自定义能力能不能真正生效的关键一环：任务侧取名字走的就是这个查询
 * （`store.ts` 的 `enabledBlock()`）。如果只查内置目录，自定义条目即使进了
 * `enabled` 也查不到名字，**等于装了没用**。
 *
 * @param lib 本机库（拿它的 `custom`）
 * @param id 条目 id
 * @returns `{ name, hint }`；查不到给 undefined
 */
export function findItemIn(
  lib: Library,
  id: string,
): { name: string; hint: string; type: "plugin" | "skill" } | undefined {
  const own = lib.custom.find((c) => c.id === id);
  if (own) return { name: own.name, hint: own.hint, type: own.type };
  return findItem(id);
}
