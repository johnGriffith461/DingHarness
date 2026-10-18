import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseArgv } from "./args";
import { cmdPlugins } from "./cmdPlugins";

/**
 * **投稿前自检**（E04，`ding plugins verify`）：
 * 在一个还没安装的目录上跑安装时的同一批检查，但不真的装。
 *
 * 判据：
 * ① 合法插件 → 退出码 0，逐项 ✓；
 * ② 声明了没导出的工具 → 非零退出，并点名那个工具（这条只有真装载才能发现）；
 * ③ 入口文件缺失 → 非零；
 * ④ `--json` 给机器可读结果（投稿流程用）。
 */

let root = "";
let dataDir = "";

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "dh-plugin-verify-"));
  dataDir = path.join(root, "data");
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows 上 worker 可能还占着：尽力而为 */
  }
});

function makePlugin(body: string, manifest: Record<string, unknown> = {}): string {
  const dir = path.join(root, "plug-" + Math.random().toString(36).slice(2, 8));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "ding-plugin.json"),
    JSON.stringify(
      {
        name: "verify-sample",
        version: "1.0.0",
        description: "给自检用的示例插件",
        tools: ["hello"],
        permissions: ["tools:register"],
        engines: { ding: ">=0.5.0" },
        ...manifest,
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(path.join(dir, "index.mjs"), body, "utf8");
  return dir;
}

/** 跑一次 verify，抓 stdout/stderr。 */
async function verify(dir: string, extra: string[] = []): Promise<{ code: number; out: string; err: string }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errs.push(args.join(" "));
  try {
    const code = await cmdPlugins(parseArgv(["plugins", "verify", dir, ...extra]), dataDir);
    return { code, out: logs.join("\n"), err: errs.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("ding plugins verify", () => {
  it("合法插件 → 0，且逐项通过", async () => {
    const dir = makePlugin(
      `export const tools = { hello: { description: "打个招呼", inputSchema: { type: "object" }, run: async () => "hi" } };`,
    );
    const got = await verify(dir);
    expect(got.code, got.err).toBe(0);
    for (const label of ["清单可读且合法", "宿主版本兼容", "入口文件存在", "工具声明与实现一致", "隔离档位"]) {
      expect(got.out).toContain(label);
    }
    expect(got.out).not.toContain("✗");
  });

  it("⭐ 声明了没导出的工具 → 非零，并点名", async () => {
    const dir = makePlugin(
      `export const tools = {};`,
      { tools: ["hello", "missing"], permissions: ["tools:register"] },
    );
    const got = await verify(dir);
    expect(got.code).not.toBe(0);
    expect(got.out).toContain("✗");
    expect(got.out).toContain("missing");
  });

  it("入口文件缺失 → 非零", async () => {
    const dir = makePlugin(`export const tools = {};`, { tools: [], permissions: [] });
    rmSync(path.join(dir, "index.mjs"));
    const got = await verify(dir);
    expect(got.code).not.toBe(0);
    expect(got.out).toContain("入口文件存在");
  });

  it("--json 给机器可读结果", async () => {
    const dir = makePlugin(
      `export const tools = { hello: { description: "x", inputSchema: { type: "object" }, run: async () => 1 } };`,
    );
    const got = await verify(dir, ["--json"]);
    const body = JSON.parse(got.out) as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(body.ok).toBe(true);
    expect(body.checks.every((c) => c.ok)).toBe(true);
    expect(body.checks.map((c) => c.name)).toContain("隔离档位");
  });
});
