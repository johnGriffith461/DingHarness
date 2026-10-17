import { describe, expect, it } from "vitest";

import { COMMAND_USAGE, KNOWN_COMMANDS } from "./help";

/**
 * CLI 帮助的完整性（U11，2026-10-18）。
 *
 * 现在的口径：**每一条命令都要有自己的用法**，而且 `--help` 成功退出（退出码 0）。
 * 这条守卫只验前半句（"表与名单一致"）；后半句由 `cli:build` 后的命令扫描验收。
 */

describe("命令表与用法表", () => {
  it("⭐ 认识的每条命令都有用法说明（漏了就会退回「缺参数，退出码 2」）", () => {
    const missing = [...KNOWN_COMMANDS].filter((c) => !COMMAND_USAGE[c]);
    expect(missing, `这些命令没有 --help 文案：${missing.join(", ")}`).toEqual([]);
  });

  it("用法表里没有不存在的命令（教用户做错事）", () => {
    const ghost = Object.keys(COMMAND_USAGE).filter((c) => !KNOWN_COMMANDS.has(c));
    expect(ghost, `用法表里有多余的命令：${ghost.join(", ")}`).toEqual([]);
  });

  it("每条用法都以 `ding ` 开头（`help` 自己那条允许最短）", () => {
    for (const [command, line] of Object.entries(COMMAND_USAGE)) {
      expect(line, command).toMatch(/^ding /);
      if (command !== "help") expect(line.length, command).toBeGreaterThan(10);
    }
  });
});
