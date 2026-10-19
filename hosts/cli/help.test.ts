import { describe, expect, it } from "vitest";

import { COMMAND_USAGE, KNOWN_COMMANDS, renderHelp } from "./help";

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

/**
 * T-10：`--help` 的**主列表**必须列出所有非工程模式命令。
 *
 * 缺陷形状（WorkBuddy 实测）：`stats` / `tree` / `jobs` / `board` / `steer` /
 * `export` / `import` 都能用，但主列表里没有 —— 用户看不到就不会用。
 * 这一条是守卫：以后新增命令忘了写进 help，第一次 `pnpm test` 就红。
 */
const DEV_ONLY = new Set(["record", "replay"]);

function helpText(devMode = false): string {
  /* T-10：直接读纯渲染函数 —— stdout 在 vitest 下被接管，截流拿不到内容 */
  return renderHelp(devMode, "C:/data");
}


describe("cmdHelp 主列表（T-10）", () => {
  it("⭐ KNOWN_COMMANDS 里每个非工程模式命令都出现在主帮助里", () => {
    const text = helpText(false);
    const missing = [...KNOWN_COMMANDS]
      .filter((cmd) => !DEV_ONLY.has(cmd))
      .filter((cmd) => !new RegExp(`^\\s+ding ${cmd}\\b`, "m").test(text));
    expect(missing, `这些命令没写进 --help：${missing.join(" / ")}`).toEqual([]);
  });

  it("七条补齐的命令各有一句用途", () => {
    const text = helpText(false);
    for (const cmd of ["stats", "tree", "jobs", "steer", "board", "export", "import"]) {
      const line = text.split("\n").find((l) => l.trimStart().startsWith(`ding ${cmd}`));
      expect(line, `${cmd} 没有出现在 help 里`).toBeTruthy();
      expect(line, `${cmd} 那行没有用途说明`).toMatch(/#\s*\S/);
    }
  });

  it("stats 的用途写的是可靠性统计", () => {
    expect(helpText(false)).toMatch(/可靠性统计/);
  });

  it("工程模式命令只在 --dev 下出现", () => {
    expect(helpText(false)).not.toMatch(/^\s+ding record\b/m);
    expect(helpText(true)).toMatch(/^\s+ding record\b/m);
  });
});
