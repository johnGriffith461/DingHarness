import { describe, expect, it } from "vitest";

import { afterWorkspaceAdd, afterWorkspaceRemove, workspaceRows } from "./WorkspaceSettings";

/**
 * F-02：设置里工作目录列表的**纯逻辑**（2026-10-20）。
 *
 * 组件本身在真机上验（`scripts/accept/accept-*.mjs`）；这里钉的是三条
 * 最容易写错的判定：列出来、加完刷新、取消选择不误报。
 */

describe("workspaceRows", () => {
  it("按 dirs 逐行给出短名（标签只用最后一段）", () => {
    expect(workspaceRows({ dirs: ["D:\\projects\\alpha", "E:\\beta"] })).toEqual([
      { dir: "D:\\projects\\alpha", label: "alpha" },
      { dir: "E:\\beta", label: "beta" },
    ]);
  });

  it("没读到 / 空列表 → 空数组（不画一行假数据）", () => {
    expect(workspaceRows(null)).toEqual([]);
    expect(workspaceRows(undefined)).toEqual([]);
    expect(workspaceRows({ dirs: [] })).toEqual([]);
  });
});

describe("afterWorkspaceAdd", () => {
  it("⭐ 选中目录 → 列表取主进程回的那份，并给出带目录名的回执", () => {
    const got = afterWorkspaceAdd(
      { dirs: [] },
      { dir: "D:\\projects\\alpha", list: { dirs: ["D:\\projects\\alpha"] } },
    );
    expect(got.dirs).toEqual(["D:\\projects\\alpha"]);
    expect(got.added).toBe("D:\\projects\\alpha");
    expect(got.note).toContain("alpha");
  });

  it("⭐ 用户取消（dir=null）→ 列表原样、**不写任何回执**", () => {
    const got = afterWorkspaceAdd({ dirs: ["D:\\a"] }, { dir: null, list: { dirs: ["D:\\a"] } });
    expect(got.dirs).toEqual(["D:\\a"]);
    expect(got.added).toBeNull();
    expect(got.note).toBe("");
  });

  it("数据通道没响应 → 列表不动，但如实说一句", () => {
    const got = afterWorkspaceAdd({ dirs: ["D:\\a"] }, undefined);
    expect(got.dirs).toEqual(["D:\\a"]);
    expect(got.note).toContain("没有响应");
  });
});

describe("afterWorkspaceRemove", () => {
  it("⭐ 撤销之后列表取主进程回的那份，回执与输入区同一句", () => {
    const got = afterWorkspaceRemove({ dirs: ["D:\\a", "D:\\b"] }, { dirs: ["D:\\b"] });
    expect(got.dirs).toEqual(["D:\\b"]);
    expect(got.note).toBe("已撤销授权");
  });

  it("数据通道没响应 → 列表不动，但如实说一句", () => {
    const got = afterWorkspaceRemove({ dirs: ["D:\\a"] }, undefined);
    expect(got.dirs).toEqual(["D:\\a"]);
    expect(got.note).toContain("没有生效");
  });
});
