import { describe, expect, it } from "vitest";

import { validateFinish, type TurnEvidence } from "./finishContract";

/**
 * P0-02：完成契约的证据校验。
 *
 * 判据是**可证伪**的：声明 done 且改过文件时，evidence.commands 里的每一条
 * 都必须在本轮真实执行过、且退出码为 0；对不上就拒绝。
 */
function evidence(executed: Array<{ command: string; exitCode: number | null }>, wroteFiles: boolean): TurnEvidence {
  return { executed, wroteFiles };
}

describe("validateFinish", () => {
  it("改过文件、没跑命令却声明 done → 拒绝", () => {
    const got = validateFinish(
      { status: "done", summary: "修好了", evidence: { files: ["src/sum.js"] } },
      evidence([], true),
    );
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("验证命令");
  });

  it("跑了 pnpm test 但退出码 1 → 拒绝", () => {
    const got = validateFinish(
      { status: "done", summary: "修好了", evidence: { commands: ["pnpm test"] } },
      evidence([{ command: "pnpm test", exitCode: 1 }], true),
    );
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("退出码");
  });

  it("命令字符串多空格 / 反斜杠 → 归一化后仍对得上则通过", () => {
    const got = validateFinish(
      { status: "done", summary: "修好了", evidence: { commands: ["  pnpm   test  "] } },
      evidence([{ command: "pnpm test", exitCode: 0 }], true),
    );
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.finish.status).toBe("done");
  });

  it("没改文件、纯问答 → 允许 done", () => {
    const got = validateFinish({ status: "done", summary: "答案是 42" }, evidence([], false));
    expect(got.ok).toBe(true);
  });

  it("blocked 没有 reason → 拒绝", () => {
    const got = validateFinish({ status: "blocked", summary: "没做成" }, evidence([], true));
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("reason");
  });

  it("blocked 带 reason → 允许，且不要求命令证据", () => {
    const got = validateFinish(
      { status: "blocked", summary: "没做成", reason: "拿不到上游凭据" },
      evidence([], true),
    );
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.finish.status).toBe("blocked");
  });

  it("声明了没执行过的命令 → 拒绝，并列出本轮真正执行过的命令", () => {
    const got = validateFinish(
      { status: "done", summary: "好了", evidence: { commands: ["pnpm test"] } },
      evidence([{ command: "node x.js", exitCode: 0 }], true),
    );
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.error).toContain("没有执行过");
      expect(got.error).toContain("node x.js");
    }
  });

  it("空 summary → 拒绝", () => {
    const got = validateFinish({ status: "done", summary: "   " }, evidence([], false));
    expect(got.ok).toBe(false);
  });
});
