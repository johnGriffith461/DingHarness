import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 内核边界守卫（Phase 1 的结构性保证）。
 *
 * ## 它钉的是哪两条不变量
 *
 * §2 的架构图写着 `core/` 是"**纯逻辑，零 IO、零 Electron —— 可整包单测**"，
 * §2.1 写着"CLI 与桌面**平权**宿主"。这两句如果只是注释，用不了多久就会失效：
 * 想让内核记一句"provider 验证过了"，最顺手的写法就是 `import { app } from "electron"`
 * —— 编译能过、桌面能跑，**只有 CLI 宿主会炸**（而 CLI 平时没人跑）。
 *
 * 这类"看起来还在，其实已经不通了"的失效，本项目吃过好几次（C6-3 拆样式文件时
 * 守卫扫了个空）。所以把它变成一条会红的断言。
 *
 * ## 判据
 *
 * | 位置 | 不许出现 |
 * |---|---|
 * | `engine/core/**` | 任何 `node:*`（那是 IO）、任何 `electron` |
 * | `engine/runtime/**`、`engine/ports/**` | 任何 `electron`（文件 IO 允许：凭据/适配器要读盘） |
 * | `hosts/**` | 任何 `electron`（CLI 是**另一个宿主**，不是桌面的一部分） |
 *
 * ⚠️ 规则是"**import 语句里**不许出现"，不是"全文不许出现这两个词"：
 * 注释里当然会提到 electron（本文件就在提），拿全文匹配等于把守卫写成噪声源。
 */

const ROOT = path.resolve(__dirname, "..");

/** 递归收 .ts/.tsx（跳过测试：测试里为了造场景可以 import 任何东西）。 */
function sources(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 目录还不存在（hosts/ 在 CLI 落地前）
  }
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** 一个文件里 `import ... from "x"` / `import("x")` 的那些 x。 */
function importSpecifiers(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: string[] = [];
  for (const m of code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** 相对仓库根的路径（正斜杠）。 */
const rel = (full: string): string => path.relative(ROOT, full).replace(/\\/g, "/");

describe("内核边界：core 零 IO、engine/hosts 不碰 electron", () => {
  const core = sources(path.join(ROOT, "engine", "core"));
  const engine = sources(path.join(ROOT, "engine"));
  const hosts = sources(path.join(ROOT, "hosts"));

  it("扫描范围不是空的（守卫别成了空扫描）", () => {
    expect(core.length).toBeGreaterThan(3);
    expect(hosts.length).toBeGreaterThan(0);
  });

  it("⭐ `engine/core/**` 不 import 任何 node:*（零 IO 是可单测的前提）", () => {
    const offenders: string[] = [];
    for (const file of core) {
      const bad = importSpecifiers(readFileSync(file, "utf8")).filter((s) => s.startsWith("node:"));
      if (bad.length) offenders.push(`${rel(file)} → ${bad.join(", ")}`);
    }
    expect(offenders, `内核核心层出现了 IO 依赖：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("⭐ `engine/**` 不 import electron（内核不认识宿主）", () => {
    const offenders = engine
      .filter((f) => importSpecifiers(readFileSync(f, "utf8")).some((s) => s === "electron" || s.startsWith("electron/")))
      .map(rel);
    expect(offenders, `内核被绑到 Electron 上了（CLI 宿主会直接崩）：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("⭐ `hosts/**` 不 import electron（CLI 是另一个宿主，不是桌面的一部分）", () => {
    const offenders = hosts
      .filter((f) => importSpecifiers(readFileSync(f, "utf8")).some((s) => s === "electron" || s.startsWith("electron/")))
      .map(rel);
    expect(offenders, `宿主里出现了 electron：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("判定本身有效（真依赖必须抓到，注释里的词不许误报）", () => {
    expect(importSpecifiers('import fs from "node:fs";')).toEqual(["node:fs"]);
    expect(importSpecifiers('const x = await import("electron");')).toEqual(["electron"]);
    expect(importSpecifiers('// import { app } from "electron"')).toEqual([]);
    expect(importSpecifiers('/* from "node:fs" */')).toEqual([]);
  });
});
