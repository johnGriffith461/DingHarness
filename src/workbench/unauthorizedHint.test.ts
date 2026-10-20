import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WORKSPACE_UNAUTHORIZED_HINT } from "@shared/workspace";
import { editFileForModel } from "@engine/runtime/tools/editTool";
import { runCommandForModel } from "@engine/runtime/tools/execTool";
import { readFileForModel } from "@engine/runtime/tools/readTool";
import { listDirForModel, searchFilesForModel } from "@engine/runtime/tools/searchTool";
import { writeFileForModel } from "@engine/runtime/tools/writeTool";

/**
 * F-02：**"不在授权范围"只有一句统一话术**（2026-10-20）。
 *
 * 方案 §0.1 #3/#4 的缺陷：向导说"之后在设置里加"，设置里却没有工作目录；
 * 五个工具还各说各的。这里不扫源码字符串，而是**真的调**每个工具一次 ——
 * 拿到的那句错误里必须包含共享常量原文，且常量自己要说清下一步去哪。
 */

let root = "";
let allowed = "";
let outside = "";
let outsideFile = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ding-ws-hint-"));
  allowed = path.join(root, "allowed");
  outside = path.join(root, "outside");
  await fs.mkdir(allowed, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  outsideFile = path.join(outside, "secret.txt");
  await fs.writeFile(outsideFile, "not yours", "utf8");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function expectHint(error: string | undefined): void {
  expect(error, "错误里没有统一话术").toContain(WORKSPACE_UNAUTHORIZED_HINT);
}

describe("五个工具被授权范围拦下时说的是同一句话", () => {
  it("read_file", async () => {
    const got = await readFileForModel(outsideFile, [allowed]);
    expect(got.ok).toBe(false);
    if (!got.ok) expectHint(got.error);
  });

  it("write_file", async () => {
    const got = await writeFileForModel(outsideFile, "x", [allowed]);
    expect(got.ok).toBe(false);
    if (!got.ok) expectHint(got.error);
  });

  it("edit_file", async () => {
    const got = await editFileForModel(outsideFile, "not", "yes", [allowed]);
    expect(got.ok).toBe(false);
    if (!got.ok) expectHint(got.error);
  });

  it("search_files", async () => {
    const got = await searchFilesForModel({ pattern: "not", path: outside }, [allowed]);
    expect(got.ok).toBe(false);
    if (!got.ok) expectHint(got.error);
  });

  it("list_dir", async () => {
    const got = await listDirForModel({ path: outside }, [allowed]);
    expect(got.ok).toBe(false);
    if (!got.ok) expectHint(got.error);
  });

  it("run_command", async () => {
    const got = await runCommandForModel({ command: "echo hi", workdir: outside }, [allowed]);
    expect(got.ok).toBe(false);
    if (!got.ok) expectHint(got.error);
  });

  it("话术本身指向设置里的那一条路径（不是一句正确的废话）", () => {
    expect(WORKSPACE_UNAUTHORIZED_HINT).toContain("设置 → 通用 → 工作目录");
    expect(WORKSPACE_UNAUTHORIZED_HINT).toContain("授权一个目录");
  });
});
