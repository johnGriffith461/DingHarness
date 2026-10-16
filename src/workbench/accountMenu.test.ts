import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { shouldCloseOnMouseDown } from "./AccountMenu";

/**
 * 守卫：**点触发菜单的那颗按钮，不能"关了又开"**（2026-10-16，审计 P83）。
 *
 * 修前实测：头像不在菜单的 `rootRef` 子树里（它是菜单的兄弟节点），于是
 * `mousedown` 判定"点在外面" → 关；紧接着按钮自己的 `click` → `setOpen(v => !v)` → 又开。
 * 用户看到的是**菜单关不掉**（而 Esc 和点别处都好使 —— 所以特别容易被当成偶发）。
 */
describe("账号菜单的关闭判据（P83）", () => {
  it("点在菜单里 → 不关（那是用户在菜单里操作）", () => {
    expect(shouldCloseOnMouseDown({ insideMenu: true, insideTrigger: false })).toBe(false);
  });

  it("⭐ 点在触发按钮上 → 不关（交给按钮自己的 toggle，否则关了又被开）", () => {
    expect(shouldCloseOnMouseDown({ insideMenu: false, insideTrigger: true })).toBe(false);
  });

  it("点在别处 → 关", () => {
    expect(shouldCloseOnMouseDown({ insideMenu: false, insideTrigger: false })).toBe(true);
  });

  it("源码守卫：那条豁免真的接着（别让它被下一次重构顺手删掉）", () => {
    const text = readFileSync(path.resolve(__dirname, "AccountMenu.tsx"), "utf8");
    const noComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(noComments, "mousedown 那条又要按「只要不在菜单里就关」判了").toContain("insideTrigger");
    expect(noComments, "触发按钮的豁免选择器不见了").toContain('[data-testid="wb-account"]');
    expect(noComments, "判定要走那个可测的函数").toContain("shouldCloseOnMouseDown({ insideMenu, insideTrigger })");
  });
});
