/**
 * 验证闭环（D1）—— 纯判断，不执行。
 *
 * 引擎没有执行体（它跑不了命令），所以这里只回答两个问题：
 * 1. 这一轮结束后**该不该**验证、验证什么命令；
 * 2. 命令的原始输出怎么压成一段**能回注给模型**的证据。
 *
 * 执行在宿主（桌面/CLI），走现有的 `run_command` 通道与同一套权限。
 */

export type ProjectContextForVerify = {
  testCommand?: string;
  cwd: string;
};

export type VerifyPlan = {
  command: string;
  reason: "test" | "build";
  cwd: string;
};

/**
 * 触发条件：编码模式 + 本轮确实写了文件 + 探测到测试命令。
 * 办公模式不触发（做 PPT 不需要跑测试）。
 */
export function shouldVerify(input: {
  wroteFiles: boolean;
  mode: "coding" | "office";
  project: ProjectContextForVerify;
}): VerifyPlan | undefined {
  if (input.mode !== "coding") return undefined;
  if (!input.wroteFiles) return undefined;
  const command = input.project.testCommand?.trim();
  if (!command) return undefined;
  return { command, reason: "test", cwd: input.project.cwd };
}

/**
 * 把命令输出压成回注给模型的一段证据。
 *
 * 规则：
 * - 通过（exit 0）只给尾部几百字，别把成功日志整段塞回上下文；
 * - 失败保留**头部 + 尾部**（错误摘要常在头、具体断言常在尾），中间写"已省略 N 字"；
 * - 任何情况下不超过 `maxChars`（默认 4000）。
 */
export function summarizeVerify(input: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  maxChars?: number;
}): { ok: boolean; excerpt: string } {
  const max = Math.max(200, input.maxChars ?? 4000);
  const ok = input.exitCode === 0;
  const body = [input.stdout ?? "", input.stderr ?? ""].filter((s) => s.trim()).join("\n").trim();
  if (!body) {
    return { ok, excerpt: ok ? "（命令没有输出，退出码 0）" : `（命令没有输出，退出码 ${input.exitCode ?? "未知"}）` };
  }
  if (body.length <= max) return { ok, excerpt: body };

  if (ok) {
    /* 成功：留尾部（构建成功/测试统计通常在尾部） */
    return { ok, excerpt: `…（前 ${body.length - max} 字省略）\n${body.slice(-max)}` };
  }
  /* 失败：头部 1/3 + 尾部 2/3 */
  const head = Math.floor(max / 3);
  const tail = max - head;
  return {
    ok,
    excerpt: `${body.slice(0, head)}\n…（中间 ${body.length - max} 字省略）…\n${body.slice(-tail)}`,
  };
}

/** 连续两次验证失败 → 建议重置（Claude Code 的最佳实践：别继续堆补丁）。 */
export function shouldSuggestReset(recentFailures: readonly boolean[]): boolean {
  if (recentFailures.length < 2) return false;
  return recentFailures.slice(-2).every((ok) => ok === false);
}

/** 验证档位（与 `ConfirmMode` 同一词表；这里只引用不复制定义）。 */
export type VerifyConfirmMode = "全部允许" | "接受编辑" | "按需确认" | "每步确认";

export type VerifyDecision = {
  action: "auto" | "offer" | "skip";
  command?: string;
  cwd?: string;
  /** 给人看的一句话（skip 时就是"未验证"的原因）。 */
  reason: string;
};

/**
 * P0-04：这一轮结束后**怎么验证**。
 *
 * - `全部允许` → `auto`（保持既有行为）；
 * - `按需确认` / `每步确认` → `offer`（界面出一张"运行验证"卡片，用户点一下才跑）；
 * - 没改文件 / 办公模式 / 没有测试命令 → `skip`，并且最终答复必须写明"未验证"。
 *
 * 这是"该不该验证、跑什么"的**唯一实现**（宿主两处都调它）。
 */
export function planVerification(input: {
  confirmMode: VerifyConfirmMode;
  wroteFiles: boolean;
  taskMode: "coding" | "office";
  project: ProjectContextForVerify;
}): VerifyDecision {
  const plan = shouldVerify({ wroteFiles: input.wroteFiles, mode: input.taskMode, project: input.project });
  if (!plan) {
    return {
      action: "skip",
      reason: input.wroteFiles
        ? "未验证（没有探测到可运行的测试命令）"
        : "未验证（这一轮没有改文件）",
    };
  }
  if (input.confirmMode === "全部允许") {
    return { action: "auto", command: plan.command, cwd: plan.cwd, reason: "全部允许档下自动验证" };
  }
  return {
    action: "offer",
    command: plan.command,
    cwd: plan.cwd,
    reason: `当前档位「${input.confirmMode}」：等你点「运行验证」`,
  };
}
