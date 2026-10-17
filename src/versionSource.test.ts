import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PRODUCT_VERSION } from "@shared/product";

/**
 * 版本单一真相（D09，2026-10-18）。
 *
 * 审计撞到的现实：npm 已经发到 `0.5.1`，根 `package.json` 还是 `0.5.0`，
 * `PRODUCT_VERSION` 也是手写的 `0.5.0` —— 三处各说各话，用户问"我装的是哪一版"
 * 得到的答案取决于问谁。
 *
 * 现在数字只有一个（`shared/version.json`）。这条测试钉住其余三处**跟着它走**：
 * 谁要升版本，改 `version.json` + 两个 `package.json`，漏一个就红。
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8")) as { version?: string };

describe("版本只有一个真相（D09）", () => {
  const source = read("shared/version.json").version;

  it("version.json 里有版本号", () => {
    expect(source).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("⭐ 运行时 PRODUCT_VERSION 就是 version.json 的值（不是手写抄本）", () => {
    expect(PRODUCT_VERSION).toBe(source);
  });

  it("⭐ 根 package.json 与它一致", () => {
    expect(read("package.json").version).toBe(source);
  });

  it("⭐ 发布包 packages/cli 与它一致（npm 上那一份）", () => {
    expect(read("packages/cli/package.json").version).toBe(source);
  });

  it("README 的状态行写的是这个版本", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
    expect(readme).toContain(`v${source}`);
  });

  it("CLI 的 --version 仍然优先读安装包自己的 package.json（补丁版要能如实报）", () => {
    const code = readFileSync(path.join(ROOT, "hosts", "cli", "ding.ts"), "utf8");
    expect(code).toContain("parsed.flags.has(\"version\")");
    expect(code).toContain('parsedPkg.name === "ding-harness"');
  });
});
