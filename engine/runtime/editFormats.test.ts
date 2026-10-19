import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyPatch, editFormatFor, parsePatch } from "./editFormats";

/**
 * D3：补丁格式的解析与应用。
 * 最容易坏的三处：多 hunk、路径逃逸、以及"解析失败却先写了一半"。
 */

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ding-patch-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, text: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return file;
}

const resolve = (p: string): string | null => {
  const target = path.resolve(root, p);
  const rel = path.relative(root, target);
  return rel.startsWith("..") || path.isAbsolute(rel) ? null : target;
};

describe("parsePatch", () => {
  it("三种操作都能解析", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: new.ts",
      "+export const a = 1;",
      "+export const b = 2;",
      "*** Update File: old.ts",
      "@@",
      "-const x = 1;",
      "+const x = 2;",
      "*** Delete File: gone.ts",
      "*** End Patch",
    ].join("\n");
    const got = parsePatch(patch);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.ops.map((o) => o.kind)).toEqual(["add", "update", "delete"]);
    expect(got.ops[0]).toMatchObject({ kind: "add", path: "new.ts", content: "export const a = 1;\nexport const b = 2;" });
  });

  it("一个 Update 里多个 @@ 段", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@",
      "-one",
      "+ONE",
      "@@",
      "-two",
      "+TWO",
      "*** End Patch",
    ].join("\n");
    const got = parsePatch(patch);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.ops[0]).toMatchObject({ kind: "update" });
    if (got.ops[0].kind !== "update") return;
    expect(got.ops[0].hunks).toHaveLength(2);
  });

  it("非法补丁报行号", () => {
    const got = parsePatch("*** Begin Patch\n*** Add File: a.ts\nnot-a-plus-line\n*** End Patch");
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.line).toBe(3);
      expect(got.error).toContain("+");
    }
  });

  it("缺标记报错", () => {
    expect(parsePatch("hello").ok).toBe(false);
    expect(parsePatch("*** Begin Patch\n*** End Patch").ok).toBe(false);
  });
});

describe("applyPatch", () => {
  it("Add / Update / Delete 都能落盘", async () => {
    write("old.ts", "const x = 1;\n");
    write("gone.ts", "bye\n");
    const ops = parsePatch(
      [
        "*** Begin Patch",
        "*** Add File: new.ts",
        "+hello",
        "*** Update File: old.ts",
        "@@",
        "-const x = 1;",
        "+const x = 2;",
        "*** Delete File: gone.ts",
        "*** End Patch",
      ].join("\n"),
    );
    expect(ops.ok).toBe(true);
    if (!ops.ok) return;

    const result = await applyPatch(root, ops.ops, { restrictToCwd: true, resolvePath: resolve });

    expect(result.ok).toBe(true);
    expect(result.changed).toEqual(["new.ts", "old.ts", "gone.ts"]);
    expect(fs.readFileSync(path.join(root, "new.ts"), "utf8")).toBe("hello");
    expect(fs.readFileSync(path.join(root, "old.ts"), "utf8")).toBe("const x = 2;\n");
    expect(fs.existsSync(path.join(root, "gone.ts"))).toBe(false);
  });

  it("⭐ 任何一条路径越界都整体拒绝（先校验再动手）", async () => {
    write("a.ts", "x");
    const ops = parsePatch(
      ["*** Begin Patch", "*** Update File: a.ts", "@@", "-x", "+y", "*** Add File: ../evil.ts", "+z", "*** End Patch"].join("\n"),
    );
    expect(ops.ok).toBe(true);
    if (!ops.ok) return;

    const result = await applyPatch(root, ops.ops, { restrictToCwd: true, resolvePath: resolve });

    expect(result.ok).toBe(false);
    expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toBe("x");
    expect(fs.existsSync(path.join(root, "..", "evil.ts"))).toBe(false);
  });

  it("Update 找不到原文 → 不写（报错）", async () => {
    write("a.ts", "original\n");
    const ops = parsePatch(["*** Begin Patch", "*** Update File: a.ts", "@@", "-nope", "+x", "*** End Patch"].join("\n"));
    if (!ops.ok) return;
    const result = await applyPatch(root, ops.ops, { restrictToCwd: true, resolvePath: resolve });
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toBe("original\n");
  });

  it("CRLF 文件改完仍是 CRLF", async () => {
    write("a.ts", "one\r\ntwo\r\n");
    const ops = parsePatch(["*** Begin Patch", "*** Update File: a.ts", "@@", "-two", "+TWO", "*** End Patch"].join("\n"));
    if (!ops.ok) return;
    await applyPatch(root, ops.ops, { restrictToCwd: true, resolvePath: resolve });
    expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toBe("one\r\nTWO\r\n");
  });
});

describe("editFormatFor", () => {
  it("未知模型默认精确替换（不赌补丁格式）", () => {
    expect(editFormatFor("whatever")).toBe("search_replace");
  });
});
