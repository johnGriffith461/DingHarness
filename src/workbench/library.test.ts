import { describe, expect, it } from "vitest";
import {
  createProject,
  EMPTY_LIBRARY,
  enabledPromptBlock,
  MAX_PINNED,
  normalizeLibrary,
  removeProject,
  renameProject,
  setProjectMember,
  toggleEnabled,
  toggleInstalled,
  togglePinned,
  type Library,
} from "@shared/library";

const CATALOG = new Set(["a", "b", "c"]);
const TASKS = new Set(["t1", "t2", "t3"]);
const NOW = 1000;

const lib = (patch: Partial<Library> = {}): Library => ({ ...EMPTY_LIBRARY, ...patch });

describe("normalizeLibrary —— 磁盘上的东西按不可信处理", () => {
  it("正常内容原样收下", () => {
    const out = normalizeLibrary(
      { installed: ["a", "b"], enabled: ["a"], pinned: ["t1"], starredFiles: ["x.md"] },
      CATALOG,
      TASKS,
    );
    expect(out.installed).toEqual(["a", "b"]);
    expect(out.enabled).toEqual(["a"]);
    expect(out.pinned).toEqual(["t1"]);
    expect(out.starredFiles).toEqual(["x.md"]);
  });

  it("**剔除已不在目录里的幽灵 id**（条目下架后不能留下「装过但找不到」）", () => {
    const out = normalizeLibrary({ installed: ["a", "removed", "b"] }, CATALOG, TASKS);
    expect(out.installed).toEqual(["a", "b"]);
  });

  it("剔除已不存在的任务 id（置顶里的悬空项会让界面出现点不开的行）", () => {
    const out = normalizeLibrary({ pinned: ["t1", "gone", "t2"] }, CATALOG, TASKS);
    expect(out.pinned).toEqual(["t1", "t2"]);
  });

  it("项目成员里的悬空 id 被剔除（否则计数对不上）", () => {
    const out = normalizeLibrary(
      { projects: [{ id: "p1", name: "甲", createdAt: 1, memberIds: ["t1", "gone"] }] },
      CATALOG,
      TASKS,
    );
    expect(out.projects[0].memberIds).toEqual(["t1"]);
  });

  it("去重（手改过或旧版本写重了）", () => {
    const out = normalizeLibrary({ installed: ["a", "a", "b"] }, CATALOG, TASKS);
    expect(out.installed).toEqual(["a", "b"]);
  });

  it("**坏字段退成空值，不整份丢掉**（整份丢掉会让用户「什么都没了」）", () => {
    const out = normalizeLibrary(
      { installed: "不是数组", enabled: null, projects: 42, pinned: ["t1"], starredFiles: "x" },
      CATALOG,
      TASKS,
    );
    expect(out.installed).toEqual([]);
    expect(out.enabled).toEqual([]);
    expect(out.projects).toEqual([]);
    expect(out.pinned).toEqual(["t1"]); // 好字段保住
    expect(out.starredFiles).toEqual([]);
  });

  it("**taskIds 传 null 表示任务集合未知，不剔任务**（否则每次重启都会清空项目与置顶）", () => {
    const out = normalizeLibrary(
      { pinned: ["t1", "t2"], projects: [{ id: "p1", name: "甲", createdAt: 1, memberIds: ["t1"] }] },
      CATALOG,
      null,
    );
    expect(out.pinned).toEqual(["t1", "t2"]);
    expect(out.projects[0].memberIds).toEqual(["t1"]);
  });

  it("传了任务集合就照常剔悬空项", () => {
    const out = normalizeLibrary({ pinned: ["t1", "gone"] }, CATALOG, TASKS);
    expect(out.pinned).toEqual(["t1"]);
  });

  it("非对象输入给空库", () => {
    expect(normalizeLibrary(null, CATALOG, TASKS)).toEqual(EMPTY_LIBRARY);
    expect(normalizeLibrary("乱来", CATALOG, TASKS)).toEqual(EMPTY_LIBRARY);
    expect(normalizeLibrary(undefined, CATALOG, TASKS)).toEqual(EMPTY_LIBRARY);
  });

  it("项目缺字段时补默认，名字空给「未命名项目」", () => {
    const out = normalizeLibrary({ projects: [{ id: "p1" }] }, CATALOG, TASKS);
    expect(out.projects).toEqual([{ id: "p1", name: "未命名项目", createdAt: 0, memberIds: [] }]);
  });

  it("没有 id 的项目被丢掉（没有 id 就无法引用）", () => {
    const out = normalizeLibrary({ projects: [{ name: "甲" }, { id: "", name: "乙" }] }, CATALOG, TASKS);
    expect(out.projects).toEqual([]);
  });

  it("置顶超上限时截断", () => {
    const many = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const out = normalizeLibrary({ pinned: many }, CATALOG, new Set(many));
    expect(out.pinned).toHaveLength(MAX_PINNED);
  });

  it("收藏里的空串与重复被清掉", () => {
    const out = normalizeLibrary({ starredFiles: ["a.md", "", "a.md", "  "] }, CATALOG, TASKS);
    expect(out.starredFiles).toEqual(["a.md"]);
  });
});

describe("toggleInstalled", () => {
  it("装 → 记下 id", () => {
    expect(toggleInstalled(lib(), "a").installed).toEqual(["a"]);
  });

  it("再点一次 → 卸载", () => {
    expect(toggleInstalled(lib({ installed: ["a"] }), "a").installed).toEqual([]);
  });

  it("**卸载时同时从 enabled 移除**（否则出现「没装但启用」的矛盾状态）", () => {
    const before = lib({ installed: ["a"], enabled: ["a"] });
    const after = toggleInstalled(before, "a");
    expect(after.installed).toEqual([]);
    expect(after.enabled).toEqual([]);
  });

  it("装别的条目不影响已启用的", () => {
    const after = toggleInstalled(lib({ installed: ["a"], enabled: ["a"] }), "b");
    expect(after.enabled).toEqual(["a"]);
  });
});

describe("toggleEnabled", () => {
  it("装过的能启用", () => {
    expect(toggleEnabled(lib({ installed: ["a"] }), "a").enabled).toEqual(["a"]);
  });

  it("**没装的不能启用**（原样返回，防止引用不存在的条目）", () => {
    const before = lib();
    expect(toggleEnabled(before, "a")).toBe(before);
  });

  it("再点一次取消启用", () => {
    expect(toggleEnabled(lib({ installed: ["a"], enabled: ["a"] }), "a").enabled).toEqual([]);
  });
});

describe("项目", () => {
  it("新建项目", () => {
    const out = createProject(lib(), "p1", "  甲  ", NOW);
    expect(out.projects).toEqual([{ id: "p1", name: "甲", createdAt: NOW, memberIds: [] }]);
  });

  it("名字为空不建（界面已拦，这是第二道）", () => {
    const before = lib();
    expect(createProject(before, "p1", "   ", NOW)).toBe(before);
  });

  it("同名不重复建（避免列表出现两个同名项）", () => {
    const before = createProject(lib(), "p1", "甲", NOW);
    expect(createProject(before, "p2", "甲", NOW).projects).toHaveLength(1);
  });

  it("重命名", () => {
    const before = createProject(lib(), "p1", "甲", NOW);
    expect(renameProject(before, "p1", "乙").projects[0].name).toBe("乙");
  });

  it("重命名成空则不动", () => {
    const before = createProject(lib(), "p1", "甲", NOW);
    expect(renameProject(before, "p1", " ").projects[0].name).toBe("甲");
  });

  it("**删项目不动任务本身**（项目只是分组）", () => {
    const before = setProjectMember(createProject(lib(), "p1", "甲", NOW), "p1", "t1");
    const after = removeProject(before, "p1");
    expect(after.projects).toEqual([]);
    // 任务没被"删掉"这件事在这个库里表现为：没有任何结构再引用它
    expect(JSON.stringify(after)).not.toContain("t1");
  });
});

describe("setProjectMember —— 一个任务只属于一个项目", () => {
  const two = setProjectMember(
    setProjectMember(createProject(createProject(lib(), "p1", "甲", NOW), "p2", "乙", NOW), "p1", "t1"),
    "p2",
    "t2",
  );

  it("加入 A 会从 B 移出（分组语义要求互斥）", () => {
    const after = setProjectMember(two, "p2", "t1");
    expect(after.projects.find((p) => p.id === "p1")?.memberIds).toEqual([]);
    expect(after.projects.find((p) => p.id === "p2")?.memberIds).toEqual(["t2", "t1"]);
  });

  it("重复加入同一个项目不产生重复项", () => {
    const after = setProjectMember(two, "p1", "t1");
    expect(after.projects.find((p) => p.id === "p1")?.memberIds).toEqual(["t1"]);
  });

  it("传 null 表示从所有项目移出", () => {
    const after = setProjectMember(two, null, "t1");
    expect(after.projects.every((p) => !p.memberIds.includes("t1"))).toBe(true);
  });
});

describe("togglePinned", () => {
  it("置顶 / 取消置顶", () => {
    expect(togglePinned(lib(), "t1").pinned).toEqual(["t1"]);
    expect(togglePinned(lib({ pinned: ["t1"] }), "t1").pinned).toEqual([]);
  });

  it("到上限后不再增加（原样返回）", () => {
    const before = lib({ pinned: Array.from({ length: MAX_PINNED }, (_, i) => `t${i}`) });
    expect(togglePinned(before, "other")).toBe(before);
  });

  it("到上限后仍能取消已有的（不能把用户锁死）", () => {
    const before = lib({ pinned: Array.from({ length: MAX_PINNED }, (_, i) => `t${i}`) });
    expect(togglePinned(before, "t0").pinned).toHaveLength(MAX_PINNED - 1);
  });
});

describe("enabledPromptBlock —— 启用项怎么交给任务", () => {
  const lookup = (id: string) => ({ name: `能力${id}`, hint: `说明${id}` });

  it("没有启用项时返回空串（不要往提示词里塞空段落）", () => {
    expect(enabledPromptBlock(lib(), lookup)).toBe("");
  });

  it("列出启用的能力与说明", () => {
    const text = enabledPromptBlock(lib({ installed: ["a"], enabled: ["a"] }), lookup);
    expect(text).toContain("能力a");
    expect(text).toContain("说明a");
    expect(text).toContain("优先用它们");
  });

  it("查不到的 id 被跳过（目录变了也不该崩）", () => {
    const text = enabledPromptBlock(lib({ installed: ["a", "gone"], enabled: ["a", "gone"] }), (id) =>
      id === "a" ? lookup(id) : undefined,
    );
    expect(text).toContain("能力a");
    expect(text).not.toContain("gone");
  });
});
