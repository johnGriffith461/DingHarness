/**
 * P0-02：`finish` 完成契约。
 *
 * ## 为什么需要它
 *
 * 用户最致命的抱怨是"假完成"：模型写了一句"已完成"，但既没跑测试、
 * 也没说自己卡在哪。Cline 的 `attempt_completion`、OpenHands 的 `FinishAction`、
 * Goose 的 `recipe__final_output` 都是**显式完成契约**——完成不是"模型不说话"，
 * 而是一次带证据的声明。
 *
 * ## 判据（可证伪）
 *
 * - `status="done"` 且本轮**改过文件** → 必须给出验证命令，且每条都真的执行过、
 *   退出码为 0；对不上就拒绝，并把本轮真正执行过的命令列给模型。
 * - `status="blocked"` → 允许没有命令证据，但必须写 `reason`。
 * - 纯问答（没改文件）→ 允许 `done`。
 *
 * 校验只有这一份实现：宿主的 finish 执行体调它，主循环只读执行体的结果。
 */

import { FINISH_TOOL } from "../../shared/agentTools";

export { FINISH_TOOL };

/** 本轮真实执行过的一条命令（由主循环从 tool-result 收集）。 */
export type ExecutedCommand = { command: string; exitCode: number | null };

/** 一轮的**真实**证据账本（主循环维护，finish 执行体读取）。 */
export type TurnEvidence = {
  executed: ExecutedCommand[];
  wroteFiles: boolean;
};

export type FinishStatus = "done" | "blocked";

export type FinishRecord = {
  status: FinishStatus;
  summary: string;
  evidence: { commands: string[]; files: string[] };
  reason?: string;
};

export type ValidateFinishResult =
  | { ok: true; finish: FinishRecord }
  | { ok: false; error: string };

/** 建一份空的账本（**每轮一份**，不能跨轮复用）。 */
export function createTurnEvidence(): TurnEvidence {
  return { executed: [], wroteFiles: false };
}

/**
 * 命令行归一化：去首尾空白、把连续空白压成一个、统一路径分隔符。
 *
 * 模型抄自己刚跑过的命令时经常多一个空格、少一个空格，或者把 `\` 写成 `/` ——
 * 那是**同一条命令**，不该因为排版差异被判成"证据不符"。
 */
export function normalizeCommand(command: string): string {
  return String(command ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\s+/g, " ");
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
}

/**
 * 校验一次 `finish` 声明。
 *
 * @param raw 模型给的工具参数（**不可信**）
 * @param evidence 本轮真实执行记录
 * @returns 通过时给出规整后的完成记录；否则给一句能直接回给模型的话
 */
export function validateFinish(raw: unknown, evidence?: TurnEvidence): ValidateFinishResult {
  if (!raw || typeof raw !== "object") return { ok: false, error: "finish 的参数必须是一个对象" };
  const o = raw as Record<string, unknown>;
  const status = o.status;
  if (status !== "done" && status !== "blocked") {
    return { ok: false, error: 'status 必须是 "done" 或 "blocked"' };
  }
  const summary = typeof o.summary === "string" ? o.summary.trim() : "";
  if (!summary) return { ok: false, error: "summary 不能为空：用一句话说清这一轮做成了什么" };
  if (summary.length > 1000) return { ok: false, error: "summary 不能超过 1000 字" };

  const evidenceInput = o.evidence && typeof o.evidence === "object" ? (o.evidence as Record<string, unknown>) : {};
  const commands = stringList(evidenceInput.commands);
  const files = stringList(evidenceInput.files);
  const reason = typeof o.reason === "string" ? o.reason.trim() : "";

  if (status === "blocked") {
    if (!reason) return { ok: false, error: "status=blocked 必须在 reason 里说明卡在哪、试过什么" };
    return {
      ok: true,
      finish: { status, summary, evidence: { commands, files }, reason },
    };
  }

  /*
   * done：改过文件就必须拿得出**本轮真的跑过**的验证命令。
   * 没改文件（纯问答）不要求 —— 但给了命令仍然只做记录，不强迫。
   */
  /*
   * ⚠️ `evidence` 省略 = 这个宿主没接账本（例如子智能体那条工具集）。
   * 此时只做结构校验，证据校验交给主循环（它有自己的账本）——
   * "没有账本"不等于"证据通过"，只是这一层判不了。
   */
  if (evidence?.wroteFiles) {
    if (commands.length === 0) {
      return {
        ok: false,
        error:
          "你改过文件，但没有给出验证命令的证据。先跑测试或构建，再把命令写进 evidence.commands；" +
          "如果确实跑不了，把 status 改成 blocked 并在 reason 里说明原因。",
      };
    }
    for (const claimed of commands) {
      const want = normalizeCommand(claimed);
      const hit = evidence.executed.find((e) => normalizeCommand(e.command) === want);
      if (!hit) {
        const ran = evidence.executed.length
          ? evidence.executed.map((e) => e.command).join("、")
          : "（这一轮没有执行过任何命令）";
        return {
          ok: false,
          error: `证据与本次实际执行不符：本轮没有执行过 \`${claimed}\`。本轮执行过：${ran}`,
        };
      }
      if (hit.exitCode !== 0) {
        return {
          ok: false,
          error: `证据与本次实际执行不符：\`${claimed}\` 的退出码是 ${hit.exitCode ?? "未知"}（只有 0 才算通过）`,
        };
      }
    }
  }

  return { ok: true, finish: { status, summary, evidence: { commands, files } } };
}

/** 从任务轨迹里取最后一条**成功**的 finish 结果（桌面侧展示用）。 */
export function finishedFromTraces(
  traces: readonly { name: string; ok: boolean; output?: unknown }[],
): FinishRecord | undefined {
  for (let i = traces.length - 1; i >= 0; i -= 1) {
    const t = traces[i];
    if (!t || t.name !== FINISH_TOOL || t.ok !== true || !t.output || typeof t.output !== "object") continue;
    const maybe = (t.output as { finished?: unknown }).finished;
    if (!maybe || typeof maybe !== "object") continue;
    const o = maybe as Record<string, unknown>;
    if (o.status !== "done" && o.status !== "blocked") continue;
    if (typeof o.summary !== "string") continue;
    return o as FinishRecord;
  }
  return undefined;
}

/** 界面/步骤上那一行回显。 */
export function describeFinish(finish: FinishRecord): string {
  if (finish.status === "blocked") return `未完成：${finish.summary}（卡点：${finish.reason ?? "未说明"}）`;
  const cmd = finish.evidence.commands.length ? `，验证：${finish.evidence.commands.join("、")}` : "";
  return `完成：${finish.summary}${cmd}`;
}
