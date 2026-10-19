import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { cliVerify, cliVerifyPlan } from "./verify";

/**
 * A-04：CLI 验证闭环。
 *
 * 决策**不重写**：`planVerification`（`engine/runtime/verifyLoop.ts`）是唯一实现，
 * 这里只负责把 CLI 的宿主事实（有没有改文件、什么档位、探测到的测试命令）喂进去，
 * 并在 `auto` 时真的跑一次。
 */
const CWD = path.resolve(".verify/verify-test-cwd");

function freshCwd(withTest: boolean): string {
  fs.rmSync(CWD, { recursive: true, force: true });
  fs.mkdirSync(CWD, { recursive: true });
  if (withTest) {
    fs.writeFileSync(
      path.join(CWD, "package.json"),
      JSON.stringify({ name: "v", scripts: { test: "node -e \"process.exit(0)\"" } }),
      "utf8",
    );
    fs.writeFileSync(path.join(CWD, "package-lock.json"), "{}", "utf8");
  }
  return CWD;
}

describe("A-04 · CLI 验证决策", () => {
  it("全部允许 + 有测试命令 + 改过文件 → auto", () => {
    const cwd = freshCwd(true);
    const got = cliVerifyPlan({ outcome: { wroteFiles: true }, mode: "全部允许", cwd });
    expect(got.action).toBe("auto");
    expect(got.command).toBe("npm test");
  });

  it("按需确认 → offer（不自动跑）", () => {
    const cwd = freshCwd(true);
    const got = cliVerifyPlan({ outcome: { wroteFiles: true }, mode: "按需确认", cwd });
    expect(got.action).toBe("offer");
    expect(got.command).toBe("npm test");
    expect(got.reason).toContain("等你");
  });

  it("每步确认 → offer", () => {
    const cwd = freshCwd(true);
    const got = cliVerifyPlan({ outcome: { wroteFiles: true }, mode: "每步确认", cwd });
    expect(got.action).toBe("offer");
  });

  it("接受编辑 → offer（编辑不问，但验证命令仍要用户点）", () => {
    const cwd = freshCwd(true);
    const got = cliVerifyPlan({ outcome: { wroteFiles: true }, mode: "接受编辑", cwd });
    expect(got.action).toBe("offer");
  });

  it("三个档位 × 没有测试命令 → 全部 skip，并说清原因", () => {
    const cwd = freshCwd(false);
    for (const mode of ["全部允许", "按需确认", "每步确认"] as const) {
      const got = cliVerifyPlan({ outcome: { wroteFiles: true }, mode, cwd });
      expect(got.action, mode).toBe("skip");
      expect(got.reason, mode).toContain("没有探测到");
    }
  });

  it("没改文件 → skip（不论档位）", () => {
    const cwd = freshCwd(true);
    const got = cliVerifyPlan({ outcome: { wroteFiles: false }, mode: "全部允许", cwd });
    expect(got.action).toBe("skip");
    expect(got.reason).toContain("没有改文件");
  });

  it("停在待确认 → skip，原因写明等确认", () => {
    const cwd = freshCwd(true);
    const got = cliVerifyPlan({
      outcome: { wroteFiles: true, awaitingApproval: { toolCallId: "c1", name: "write_file" } },
      mode: "按需确认",
      cwd,
    });
    expect(got.action).toBe("skip");
    expect(got.reason).toContain("等确认");
  });

  it("auto 时真的跑一次命令，结果进 auto 载荷", async () => {
    const cwd = freshCwd(true);
    let ran = 0;
    const got = await cliVerify(
      { outcome: { wroteFiles: true }, mode: "全部允许", cwd, dirs: [cwd] },
      {
        runCommand: async (command, where) => {
          ran += 1;
          expect(command).toBe("npm test");
          expect(where).toBe(cwd);
          return { exitCode: 0, stdout: "all good", stderr: "" };
        },
      },
    );
    expect(ran).toBe(1);
    expect(got.action).toBe("auto");
    if (got.action === "auto") {
      expect(got.ok).toBe(true);
      expect(got.exitCode).toBe(0);
      expect(got.excerpt).toContain("all good");
    }
  });

  it("auto 的命令失败 → ok=false，excerpt 保留输出", async () => {
    const cwd = freshCwd(true);
    const got = await cliVerify(
      { outcome: { wroteFiles: true }, mode: "全部允许", cwd, dirs: [cwd] },
      { runCommand: async () => ({ exitCode: 2, stdout: "", stderr: "1 failing test" }) },
    );
    expect(got.action).toBe("auto");
    if (got.action === "auto") {
      expect(got.ok).toBe(false);
      expect(got.excerpt).toContain("1 failing test");
    }
  });

  it("offer 时不执行命令（执行体一次都不该被调）", async () => {
    const cwd = freshCwd(true);
    let ran = 0;
    const got = await cliVerify(
      { outcome: { wroteFiles: true }, mode: "按需确认", cwd, dirs: [cwd] },
      { runCommand: async () => ((ran += 1), { exitCode: 0, stdout: "", stderr: "" }) },
    );
    expect(got.action).toBe("offer");
    expect(ran).toBe(0);
  });
});
