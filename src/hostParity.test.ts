import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * C-02：双宿主能力对照表的**守卫**。
 *
 * 为什么它必须存在：桌面与 CLI 跑同一个内核，但"有哪些宿主入口"这张表不会自己保持正确。
 * 加能力时只接一端、或者删掉某个入口忘了改表，单测都不会红 —— 用户会在另一边撞墙。
 *
 * 判据（方案原文）：不一致条目 ≤ 2，且每条都有归属卡号；每条都要指到源码位置。
 * 表在仓库根（`PARITY.md`）：`docs/` 是 gitignored 的，守卫在 CI 里读不到。
 */

const FILE = path.resolve(__dirname, "..", "PARITY.md");

type Row = { ability: string; desktop: string; cli: string; parity: string; card: string };

function parseRows(): Row[] {
  const text = readFileSync(FILE, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|") && !/^\|\s*-+/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length === 5 && cells[0] !== "能力")
    .map(([ability, desktop, cli, parity, card]) => ({ ability: ability!, desktop: desktop!, cli: cli!, parity: parity!, card: card! }));
}

describe("C-02 · 双宿主能力对照", () => {
  const rows = parseRows();

  it("覆盖方案点名的 14 类能力", () => {
    const names = rows.map((r) => r.ability);
    for (const required of [
      "审批",
      "验证闭环",
      "审阅回滚",
      "todo",
      "finish",
      "ask_user",
      "Markdown",
      "附件",
      "计划模式",
      "MCP",
      "技能",
      "后台任务",
      "命令 stdin",
      "web_fetch",
    ]) {
      expect(names.some((n) => n.includes(required)), `表里缺「${required}」`).toBe(true);
    }
  });

  it("每一行都指到源码位置（桌面与 CLI 两侧都要有文件名）", () => {
    for (const row of rows) {
      expect(row.desktop, `${row.ability} 的桌面列没有源码位置`).toMatch(/\.(ts|tsx|mjs)/);
      /* 不一致的行允许写"无对应路径"，但也要指到桌面那一侧的证据文件 */
      if (row.parity === "不一致") {
        expect(row.cli, `${row.ability} 标了不一致却没说明 CLI 侧的情况`).toMatch(/无对应路径|没有/);
      } else {
        expect(row.cli, `${row.ability} 的 CLI 列没有源码位置`).toMatch(/\.(ts|tsx|mjs)/);
      }
    }
  });

  it("不一致条目 ≤ 2（方案给的预算）", () => {
    const bad = rows.filter((r) => r.parity === "不一致");
    expect(bad.map((r) => r.ability), "不一致条目超预算了 —— 要么补路径，要么写清归属卡").toHaveLength(
      Math.min(2, bad.length),
    );
    expect(bad.length).toBeLessThanOrEqual(2);
  });

  it("每条不一致都有归属卡号", () => {
    for (const row of rows.filter((r) => r.parity === "不一致")) {
      expect(row.card, `${row.ability} 没有归属卡号`).toMatch(/^[A-Z]-\d+(-[A-Za-z0-9]+)?$/);
    }
  });

  it("一致的行不写归属卡（避免把'已对齐'混进待办）", () => {
    for (const row of rows.filter((r) => r.parity.startsWith("一致"))) {
      expect(["—", "-", ""], `${row.ability} 标了一致却挂着卡 ${row.card}`).toContain(row.card);
    }
  });
});
