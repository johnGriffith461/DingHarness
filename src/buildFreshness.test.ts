import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * 交付门 A（D01）：产物必须比源码新。
 *
 * 这组断言挡的是**最容易被当成"已完成"的那种坏**：单测全绿、应用能开，
 * 但用户看到的界面是上一轮的（`dist/` 没重建）。所以这里直接跑脚本本体，
 * 在一个临时仓库里造"新鲜 / 过期 / 缺失 / 测试文件更新"四种局面。
 */

const SCRIPT = path.resolve(__dirname, "..", "scripts", "check-build-freshness.mjs");
const roots: string[] = [];

/** 一个够脚本判定用的最小仓库。 */
function makeTree(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-fresh-"));
  roots.push(root);
  const files = [
    "src/app.tsx",
    "shared/contract.ts",
    "index.html",
    "vite.config.ts",
    "tsconfig.json",
    "electron/main.ts",
    "engine/core/loop.ts",
    "hosts/cli/ding.ts",
    "tsconfig.electron.json",
    "tsconfig.cli.json",
    "package.json",
  ];
  for (const f of files) {
    const full = path.join(root, f);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, "// source\n", "utf8");
  }
  // 三份产物：默认比所有源码新（基准时间 2000 秒）
  for (const out of ["dist/index.html", "dist-electron/electron/main.cjs", "dist-cli/hosts/cli/ding.js"]) {
    const full = path.join(root, out);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, "// built\n", "utf8");
  }
  touch(root, "src/app.tsx", 1000);
  touch(root, "shared/contract.ts", 1000);
  touch(root, "electron/main.ts", 1000);
  touch(root, "engine/core/loop.ts", 1000);
  touch(root, "hosts/cli/ding.ts", 1000);
  for (const f of ["index.html", "vite.config.ts", "tsconfig.json", "package.json", "tsconfig.electron.json", "tsconfig.cli.json"]) {
    touch(root, f, 1000);
  }
  for (const out of ["dist/index.html", "dist-electron/electron/main.cjs", "dist-cli/hosts/cli/ding.js"]) {
    touch(root, out, 2000);
  }
  return root;
}

/** 把某个文件的 mtime 设成指定秒数（测试里不依赖真实时钟）。 */
function touch(root: string, rel: string, seconds: number): void {
  const at = new Date(seconds * 1000);
  utimesSync(path.join(root, rel), at, at);
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, `--root=${root}`, ...args], { encoding: "utf8" });
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("产物新鲜度门（D01）", () => {
  it("三份产物都比源码新 → 通过", () => {
    const got = run(makeTree());
    expect(got.status, got.stderr).toBe(0);
    expect(got.stdout).toContain("产物新鲜");
  });

  it("⭐ 改了 src 却没重建 web → 红，并说清是哪份、旧多少", () => {
    const root = makeTree();
    touch(root, "src/app.tsx", 3000);
    const got = run(root, "--only=web");
    expect(got.status).toBe(1);
    expect(got.stderr).toContain("dist/index.html 比源码旧");
    expect(got.stderr).toContain("src/app.tsx");
  });

  it("缺产物 → 红（而不是把它当成「没有源码依赖」悄悄放过）", () => {
    const root = makeTree();
    rmSync(path.join(root, "dist-cli/hosts/cli/ding.js"));
    const got = run(root, "--only=cli");
    expect(got.status).toBe(1);
    expect(got.stderr).toContain("产物不存在");
  });

  it("只改了测试文件 → **不**要求重建（测试不参与构建）", () => {
    const root = makeTree();
    writeFileSync(path.join(root, "src/app.test.tsx"), "// test\n", "utf8");
    touch(root, "src/app.test.tsx", 3000);
    const got = run(root, "--only=web");
    expect(got.status, got.stderr).toBe(0);
  });

  it("依赖隔离：改 CLI 源码不会让桌面端被误判过期", () => {
    const root = makeTree();
    touch(root, "hosts/cli/ding.ts", 3000);
    const got = run(root, "--only=web,electron");
    expect(got.status, got.stderr).toBe(0);
  });
});
