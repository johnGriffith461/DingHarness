import { describe, expect, it } from "vitest";

import {
  COMPUTER_KEYS,
  COMPUTER_TYPE_MAX,
  auditOf,
  buildClickScript,
  buildKeyScript,
  buildTypeScript,
  psQuote,
  validateComputerAction,
} from "@shared/computer";

/**
 * Computer Use 的纯策略（V6-2n）。
 *
 * 这些判据都在"真正碰桌面之前"：坐标越界、按键不在白名单、输入超长、
 * 以及**审计不记录输入文字**。脚本构造只验形状（不执行 PowerShell）。
 */

const screen = { width: 1920, height: 1080 };

describe("动作校验", () => {
  it("截图永远合法；点击坐标必须是屏幕内的整数", () => {
    expect(validateComputerAction({ kind: "screenshot" }, screen)).toBeNull();
    expect(validateComputerAction({ kind: "click", x: 10, y: 20 }, screen)).toBeNull();
    expect(validateComputerAction({ kind: "click", x: 1920, y: 20 }, screen)).toContain("超出屏幕");
    expect(validateComputerAction({ kind: "click", x: -1, y: 20 }, screen)).toContain("超出屏幕");
    expect(validateComputerAction({ kind: "click", x: 1.5, y: 20 }, screen)).toContain("整数");
    expect(validateComputerAction({ kind: "click", x: 1, y: 1, button: "middle" }, screen)).toContain("left / right");
  });

  it("输入：空 / 超长都拒绝", () => {
    expect(validateComputerAction({ kind: "type", text: "你好" }, screen)).toBeNull();
    expect(validateComputerAction({ kind: "type", text: "" }, screen)).toContain("空的");
    expect(validateComputerAction({ kind: "type", text: "x".repeat(COMPUTER_TYPE_MAX + 1) }, screen)).toContain("最多");
  });

  it("按键白名单：只认列出来的（不许任意字符串进 SendKeys）", () => {
    for (const key of COMPUTER_KEYS) expect(validateComputerAction({ kind: "key", key }, screen)).toBeNull();
    expect(validateComputerAction({ kind: "key", key: "rm -rf /" }, screen)).toContain("不支持");
  });

  it("不认识的动作 / 非对象都拒绝", () => {
    expect(validateComputerAction({ kind: "delete_os" }, screen)).toContain("不认识");
    expect(validateComputerAction(null, screen)).toContain("对象");
  });
});

describe("脚本构造（Windows）", () => {
  it("点击：坐标进脚本、右键用不同的 down/up 标志", () => {
    const left = buildClickScript({ kind: "click", x: 12, y: 34 });
    expect(left).toContain("SetCursorPos(12, 34)");
    expect(left).toContain("0x0002");
    const right = buildClickScript({ kind: "click", x: 5, y: 6, button: "right" });
    expect(right).toContain("0x0008");
    expect(right).toContain("0x0010");
  });

  it("按键：白名单映射到 SendKeys（ctrl+a / alt+tab）", () => {
    expect(buildKeyScript("enter")).toContain("{ENTER}");
    expect(buildKeyScript("ctrl+a")).toContain("^a");
    expect(buildKeyScript("alt+tab")).toContain("%{TAB}");
  });

  it("输入：PowerShell 单引号转义（文字里的引号不会造成注入）", () => {
    expect(psQuote("it's")).toBe("'it''s'");
    const script = buildTypeScript("你好 '世界'");
    expect(script).toContain("Set-Clipboard");
    expect(script).toContain("'你好 ''世界'''");
    expect(script).toContain("SendWait('^v')");
    /* 粘完还原剪贴板（不把用户原有的内容留在剪贴板里） */
    expect(script).toContain("Set-Clipboard -Value $old");
  });
});

describe("审计", () => {
  it("⭐ 输入文字不记录（只记字符数）", () => {
    const entry = auditOf({ kind: "type", text: "我的密码是 hunter2" }, true, "已输入", 1000);
    expect(entry.detail).not.toContain("hunter2");
    expect(entry.detail).not.toContain("密码");
    expect(entry.detail).toContain(`${"我的密码是 hunter2".length} 个字符`);
    expect(entry).toMatchObject({ at: 1000, kind: "type", ok: true });
  });

  it("点击记坐标、截图记结果", () => {
    expect(auditOf({ kind: "click", x: 3, y: 4 }, true, "点了 (3,4)", 1).detail).toContain("(3,4)");
    expect(auditOf({ kind: "screenshot" }, false, "没授权", 2)).toMatchObject({ kind: "screenshot", ok: false });
  });
});
