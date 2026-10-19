import { describe, expect, it } from "vitest";

import { isEditToolName, isInsideWorkspace, isProtectedPath, pathsOfEdit } from "./editGuard";

/**
 * B-01：「接受编辑」档的路径守卫。
 *
 * 这一层是**唯一实现**：policy 判定与宿主执行都调它。
 * 判据按方案原文：`.git/`、`.env`、`.env.*`、`.ssh/`、`node_modules/`、
 * `..` 逃逸、工作区外绝对路径 —— 一律算"仍需确认"。
 */
describe("B-01 · isProtectedPath", () => {
  it("保护 .env 与 .env.*", () => {
    for (const p of [".env", "config/.env", ".env.local", "D:/repo/.env.production"]) {
      expect(isProtectedPath(p), p).toBe(true);
    }
  });

  it("保护 .git/（但不误伤 .gitignore）", () => {
    expect(isProtectedPath(".git/config")).toBe(true);
    expect(isProtectedPath("repo/.git/hooks/pre-commit")).toBe(true);
    expect(isProtectedPath(".gitignore")).toBe(false);
  });

  it("保护 .ssh/ 与 node_modules/", () => {
    expect(isProtectedPath(".ssh/id_rsa")).toBe(true);
    expect(isProtectedPath("node_modules/react/index.js")).toBe(true);
  });

  it("保护 .. 逃逸（含深层）", () => {
    for (const p of ["..", "../outside.txt", "src/../../etc/passwd", "a/b/../../../x"]) {
      expect(isProtectedPath(p), p).toBe(true);
    }
  });

  it("空路径保守算保护（说不清就问）", () => {
    expect(isProtectedPath("")).toBe(true);
    expect(isProtectedPath("   ")).toBe(true);
  });

  it("普通源码路径不算保护", () => {
    for (const p of ["src/a.ts", "README.md", "documentation/x/y.md", "a.b.md"]) {
      expect(isProtectedPath(p), p).toBe(false);
    }
  });
});

describe("B-01 · isInsideWorkspace", () => {
  const dirs = ["C:/work/repo"];

  it("相对路径按第一个授权目录解析", () => {
    expect(isInsideWorkspace("src/a.ts", dirs)).toBe(true);
  });

  it("绝对路径在授权目录里 → true；外面 → false", () => {
    expect(isInsideWorkspace("C:/work/repo/src/a.ts", ["C:/work/repo"])).toBe(true);
    expect(isInsideWorkspace("C:/Windows/System32/x.dll", ["C:/work/repo"])).toBe(false);
  });

  it("反斜杠写法与正斜杠等价", () => {
    expect(isInsideWorkspace("C:\\work\\repo\\src\\a.ts", ["C:/work/repo"])).toBe(true);
  });

  it(".. 逃出工作区 → false", () => {
    expect(isInsideWorkspace("../outside.txt", dirs)).toBe(false);
    expect(isInsideWorkspace("src/../../outside.txt", dirs)).toBe(false);
  });

  it("没有授权目录时一律 false（说不清就确认）", () => {
    expect(isInsideWorkspace("src/a.ts", [])).toBe(false);
  });
});

describe("B-01 · pathsOfEdit", () => {
  it("write_file / edit_file 取 path", () => {
    expect(pathsOfEdit("write_file", { path: "src/a.ts" })).toEqual(["src/a.ts"]);
    expect(pathsOfEdit("edit_file", { path: "src/a.ts", find: "x", replace: "y" })).toEqual(["src/a.ts"]);
  });

  it("apply_patch 从补丁文本里取每个文件的路径", () => {
    const patch = ["*** Begin Patch", "*** Update File: src/a.ts", "@@", "*** Add File: src/b.ts", "+x", "*** Delete File: old.txt", "*** End Patch"].join("\n");
    expect(pathsOfEdit("apply_patch", { patchText: patch })).toEqual(["src/a.ts", "src/b.ts", "old.txt"]);
  });

  it("解析不出路径 → 空数组（调用方据此仍然确认）", () => {
    expect(pathsOfEdit("apply_patch", { patchText: "乱写" })).toEqual([]);
    expect(pathsOfEdit("write_file", {})).toEqual([]);
  });

  it("isEditToolName 只认三个编辑工具", () => {
    for (const name of ["write_file", "edit_file", "apply_patch"]) expect(isEditToolName(name)).toBe(true);
    for (const name of ["read_file", "run_command", "mcp__x__y", "job_kill"]) expect(isEditToolName(name)).toBe(false);
  });
});
