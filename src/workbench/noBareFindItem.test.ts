import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 机械约束：**渲染层不许直接用裸 `findItem(`**。
 *
 * ## 为什么要用测试来钉，而不是写注释
 * "一个概念两个入口、改了一个忘了另一个"这个形状，在这个项目里出现了三次：
 *
 * | 节 | 漏配 |
 * |---|---|
 * | §43 | 协议属性只加在对话流卡片，右侧面板没加 |
 * | §49 | `custom` 不被剔，但它的 id 不算合法 |
 * | §52 | 输入区用 `findItemIn`，管理页还用 `findItem` |
 *
 * 前两次是靠跑端到端撞出来的、第三次是定向查出来的 —— 都是**靠人记得**。
 * 注释挡不住这个：下一个人（或者下一个我）照样会写 `findItem(id)`，
 * 因为它在类型上完全合法、不报错、单测也过。
 *
 * 所以这里把它变成**能自动检查的**：谁再写裸 `findItem(`，这条测试就红。
 *
 * `findItem` 本身没被废弃 —— 它是 `findItemIn` 的回落分支。约束只针对**调用点**。
 */

const SRC = "src";

/** 递归列出目录下的 .ts/.tsx（跳过测试文件本身）。 */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sources(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

/** 允许直接调用 `findItem` 的地方（只有封装它的那一处）。 */
const ALLOWED = ["libraryStore.ts"];

describe("渲染层不许直接用裸 findItem", () => {
  it("**没有例外之外的文件调用 findItem(**", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      if (ALLOWED.some((ok) => file.endsWith(ok))) continue;
      const text = readFileSync(file, "utf8");
      // 匹配 findItem( 但**不匹配** findItemIn( 与 import 语句
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        /*
         * 只跳过**导入/再导出**语句 —— 不能连 `export const x = () => findItem(...)` 一起跳过。
         * 第一版跳了所有 `export` 开头的行，于是注入到 `export const` 里的违规漏过去了。
         */
        if (/^\s*import\b/.test(line)) return;
        if (/^\s*export\b[^;]*\bfrom\b/.test(line)) return;
        if (/findItemIn\(/.test(line)) return;
        /*
         * 跳过**声明**本身（`export function findItem(` / `const findItem =`）——
         * 约束针对的是"谁在调它"，不是"它自己被定义"。第二版漏了这一条，把 catalog.ts
         * 的定义也报了警。两次都是靠"先让它红一次、再让它绿一次"把守卫自己的洞找出来的。
         */
        if (/\bfunction\s+findItem\s*\(/.test(line)) return;
        if (/\bfindItem\s*=/.test(line)) return;
        if (/\bfindItem\(/.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      [
        "渲染层出现了裸 findItem( 调用 —— 它查不到自定义能力。",
        "请改用 libraryStore 的 findItemIn(lib, id)（自定义优先、回落目录）。",
        offenders.join("\n"),
      ].join("\n"),
    ).toEqual([]);
  });

  it("允许清单里的那一处确实在用它（否则这条约束就没有意义了）", () => {
    const host = readFileSync(join(SRC, "workbench", "libraryStore.ts"), "utf8");
    expect(host).toContain("findItemIn");
    expect(host).toContain("findItem(id)");
  });
});
