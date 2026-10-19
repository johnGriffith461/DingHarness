import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listWorkspaceDir, readWorkspaceFile, searchWorkspaceEntries } from "./workspaceFiles";

/**
 * B1：`@` 文件/目录候选的读盘边界。
 * 它挡的是"`@` 菜单变成第二个任意读盘口子"与"大目录把界面卡死"。
 */

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ding-mentions-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, text = "x"): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return file;
}

describe("searchWorkspaceEntries", () => {
  it("按查询词命中文件与目录，目录排前面", async () => {
    write("src/app.ts");
    write("src/lib/helper.ts");
    write("notes/readme.md");

    const got = await searchWorkspaceEntries(root, "src");

    expect(got[0]?.kind).toBe("dir");
    expect(got.map((e) => e.label)).toContain("src/app.ts");
    expect(got.map((e) => e.label)).toContain("src/lib/helper.ts");
    expect(got.map((e) => e.label)).not.toContain("notes/readme.md");
  });

  it("排除 node_modules / .git / dist", async () => {
    write("src/a.ts");
    write("node_modules/pkg/index.js");
    write("dist/out.js");
    write(".git/config");

    const got = await searchWorkspaceEntries(root, "");

    expect(got.some((e) => e.label.includes("node_modules"))).toBe(false);
    expect(got.some((e) => e.label.startsWith("dist"))).toBe(false);
    expect(got.some((e) => e.label.includes(".git"))).toBe(false);
    /* 空查询只列顶层：`src` 目录在，里面的文件不在（要看文件就继续输入） */
    expect(got.some((e) => e.label === "src" && e.kind === "dir")).toBe(true);
    expect(got.some((e) => e.label === "src/a.ts")).toBe(false);
  });

  it("敏感文件不出现在候选里", async () => {
    write(".env", "KEY=1");
    write("certs/server.pem", "x");
    write("src/a.ts");

    const got = await searchWorkspaceEntries(root, "");

    expect(got.some((e) => e.label.includes(".env"))).toBe(false);
    expect(got.some((e) => e.label.includes(".pem"))).toBe(false);
  });

  it("空查询只列顶层（深层文件不出现）", async () => {
    write("README.md");
    write("src/deep/b.ts");

    const got = await searchWorkspaceEntries(root, "");

    expect(got.map((e) => e.label)).toContain("README.md");
    expect(got.map((e) => e.label)).toContain("src");
    expect(got.map((e) => e.label)).not.toContain("src/deep/b.ts");
  });

  it("最多返回 20 条，且扫描有上限", async () => {
    for (let i = 0; i < 40; i += 1) write(`files/f${i}.ts`);
    const got = await searchWorkspaceEntries(root, "f");
    expect(got).toHaveLength(20);
  });
});

describe("listWorkspaceDir / readWorkspaceFile", () => {
  it("列目录只给直接子项", async () => {
    write("src/a.ts");
    write("src/deep/b.ts");
    const got = await listWorkspaceDir(root, "src");
    const labels = got.map((e) => e.label).sort();
    expect(labels).toContain("a.ts");
    expect(labels).toContain("deep");
    expect(labels).not.toContain("b.ts");
  });

  it("越界路径被拒（含 ../ 逃逸）", async () => {
    const outside = path.join(path.dirname(root), "outside-secret.txt");
    fs.writeFileSync(outside, "secret", "utf8");
    try {
      const got = await readWorkspaceFile(root, "../outside-secret.txt");
      expect(got.ok).toBe(false);
      expect(await listWorkspaceDir(root, "..")).toEqual([]);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("读文本文件成功；二进制被拒", async () => {
    write("src/a.ts", "export const a = 1;");
    write("bin/blob.bin", "");
    fs.writeFileSync(path.join(root, "bin/blob.bin"), Buffer.from([0, 1, 2, 3]));

    expect(await readWorkspaceFile(root, "src/a.ts")).toMatchObject({ ok: true, text: "export const a = 1;" });
    const bin = await readWorkspaceFile(root, "bin/blob.bin");
    expect(bin.ok).toBe(false);
  });
});
