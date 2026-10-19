import { detectEnvironment } from "../../engine/runtime/projectContext";
import { runCommandForModel } from "../../engine/runtime/tools/execTool";
import { planVerification, summarizeVerify, type VerifyConfirmMode, type VerifyDecision } from "../../engine/runtime/verifyLoop";
import type { ConfirmMode } from "../../shared/ipc";

/**
 * A-04：CLI 的验证闭环。
 *
 * ## 它不重写判定
 *
 * "该不该验证、跑什么命令"只有一份实现：`engine/runtime/verifyLoop.ts` 的
 * `planVerification`。这里只做两件宿主该做的事：
 *
 * 1. 把 CLI 的事实喂进去（有没有改文件、当前档位、`package.json` 里探测到的测试命令）；
 * 2. 决策为 `auto` 时**真的跑一次**，并把输出压成能回注给模型的证据。
 *
 * 测试命令探测也复用 `projectContext.detectEnvironment`（不另写一份 `package.json` 解析）——
 * 两份探测迟早会在"pnpm 还是 npm"这类细节上分叉。
 */

export type CliVerifyResult =
  | { action: "auto"; command: string; exitCode: number | null; ok: boolean; excerpt: string }
  | { action: "offer"; command: string; reason: string }
  | { action: "skip"; reason: string };

export type CliVerifyOutcomeLike = {
  wroteFiles?: boolean;
  awaitingApproval?: unknown;
};

export type CliVerifyInput = {
  outcome: CliVerifyOutcomeLike;
  mode: ConfirmMode;
  /** 探测得从哪个目录读（通常是第一个授权目录）。 */
  cwd: string;
  /** 跑命令时的工作目录白名单（`run_command` 的同一套）。 */
  dirs: readonly string[];
  /** 测试用注入；省略 = 按 `package.json` 探测。 */
  testCommand?: string;
};

/** 决策（纯函数；`auto/offer/skip` 与桌面同一口径）。 */
export function cliVerifyPlan(input: {
  outcome: CliVerifyOutcomeLike;
  mode: ConfirmMode;
  cwd: string;
  testCommand?: string;
}): VerifyDecision {
  /*
   * 停在待确认上：这一轮的命令**一条都没执行**，拿"写了文件"去跑验证
   * 会把一个还没批准的动作当成已完成，验证结果也就没有意义。
   */
  if (input.outcome.awaitingApproval) {
    return { action: "skip", reason: "未验证（这一轮停在待确认上，等确认后再跑）" };
  }
  const env = input.testCommand !== undefined ? { testCommand: input.testCommand } : detectEnvironment({ cwd: input.cwd });
  return planVerification({
    /* 目前两套词表同形；`接受编辑` 会在 B-01 加进 VerifyConfirmMode */
    confirmMode: input.mode as VerifyConfirmMode,
    wroteFiles: input.outcome.wroteFiles === true,
    /* CLI 的系统提示词就是编码契约（P0-08），所以任务模式恒为 coding */
    taskMode: "coding",
    project: { cwd: input.cwd, ...(env.testCommand ? { testCommand: env.testCommand } : {}) },
  });
}

/** 命令执行结果（默认实现把 `run_command` 的载荷翻成这个形状）。 */
export type VerifyRunResult = { exitCode: number | null; stdout: string; stderr: string };

/**
 * 决策 + （auto 时）执行。
 *
 * @param deps.runCommand 注入点（单测用；默认走 `run_command` 的同一个执行体）
 */
export async function cliVerify(
  input: CliVerifyInput,
  deps: { runCommand?: (command: string, cwd: string, dirs: readonly string[]) => Promise<VerifyRunResult> } = {},
): Promise<CliVerifyResult> {
  const decision = cliVerifyPlan(input);
  if (decision.action === "skip") return { action: "skip", reason: decision.reason };
  if (decision.action === "offer") {
    return { action: "offer", command: decision.command ?? "", reason: decision.reason };
  }
  const command = decision.command ?? "";
  const cwd = decision.cwd ?? input.cwd;
  const run =
    deps.runCommand ??
    (async (cmd: string, where: string, dirs: readonly string[]): Promise<VerifyRunResult> => {
      const result = await runCommandForModel({ command: cmd, workdir: where }, dirs);
      if (!result.ok) return { exitCode: null, stdout: "", stderr: result.error };
      return { exitCode: result.exitCode, stdout: result.output, stderr: "" };
    });
  const raw = await run(command, cwd, input.dirs);
  /* 尾部 800 字：CLI 的终端空间比桌面紧，成功日志不需要整段 */
  const summary = summarizeVerify({ exitCode: raw.exitCode, stdout: raw.stdout, stderr: raw.stderr, maxChars: 800 });
  return { action: "auto", command, exitCode: raw.exitCode, ok: summary.ok, excerpt: summary.excerpt };
}
