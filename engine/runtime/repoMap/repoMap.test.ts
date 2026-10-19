import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildRepoMap } from "./index";
import { parseSymbols } from "./parse";
import { renderMap } from "./render";

/**
 * E1：仓库地图。
 * 判据：符号抽得对、排除目录不出现、预算收敛（≤15%）、不支持的语言跳过并计数。
 */

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ding-map-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, text: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

describe("parseSymbols", () => {
  it("函数 / 类 / 接口 / 类型 / 变量都能抽到", () => {
    const got = parseSymbols(
      "a.ts",
      [
        "export function alpha() {}",
        "export class Beta {}",
        "export interface Gamma { x: number }",
        "export type Delta = string;",
        "export const epsilon = 1;",
      ].join("\n"),
    );
    expect(got.map((s) => s.name)).toEqual(["alpha", "Beta", "Gamma", "Delta", "epsilon"]);
  });

  it("不支持的语言返回空", () => {
    expect(parseSymbols("a.py", "def foo(): pass")).toEqual([]);
  });
});

describe("buildRepoMap", () => {
  it("小仓库生成正确符号，排除目录不出现", async () => {
    write("src/a.ts", "export function alpha() {}\nexport function beta() { return alpha(); }");
    write("src/b.ts", "import { alpha } from './a';\nexport const useAlpha = alpha;");
    write("node_modules/x/i.ts", "export function nope() {}");
    write("dist/out.ts", "export function alsoNope() {}");

    const got = await buildRepoMap(root);

    expect(got.files).toBe(2);
    expect(got.text).toContain("alpha");
    expect(got.text).toContain("useAlpha");
    expect(got.text).not.toContain("nope");
    expect(got.text).not.toContain("alsoNope");
  });

  it("不支持的文件跳过并计数", async () => {
    write("src/a.ts", "export const x = 1;");
    write("docs/readme.md", "# hi");
    write("scripts/x.py", "print(1)");

    const got = await buildRepoMap(root);
    expect(got.skipped).toBeGreaterThanOrEqual(2);
    expect(got.text).toContain("x");
  });

  it("预算 256 token 时二分收敛（不超预算太多）", async () => {
    for (let i = 0; i < 60; i += 1) write(`src/f${i}.ts`, `export function fn${i}() { return ${i}; }`);
    const got = await buildRepoMap(root, { maxTokens: 256 });
    const tokens = Math.ceil(got.text.length / 4);
    expect(tokens).toBeLessThanOrEqual(256 * 1.15 + 40);
    expect(got.text).toContain("已省略");
  });
});

describe("renderMap", () => {
  it("空输入返回空串", () => {
    expect(renderMap([])).toBe("");
  });
});
