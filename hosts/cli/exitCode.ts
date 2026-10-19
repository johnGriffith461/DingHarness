/**
 * A-03：CLI 退出码的**唯一映射**。
 *
 * 0 成功 / 1 失败 / 2 用法错误 / 3 没有可用 provider / 4 预算暂停 / 6 等待人工确认
 *
 * 为什么不继续写在 `cmdRun` 的一串 if 里：退出码是**脚本能看见的契约**，
 * 而原来"待确认"沿用 0 —— 脚本无法把"它停下来等人"与"它做完了"区分开。
 * 抽成纯函数之后，这张表可以被单测钉住，也可以被文档直接引用。
 */
export type CliOutcomeLike = {
  ok: boolean;
  error?: string;
  aborted?: boolean;
  /** 内核的 running/paused 状态（预算暂停 = 4）。 */
  state?: string;
  awaitingApproval?: { toolCallId: string; name: string };
};

/** 等待人工确认的退出码（写进 help / README；改它要同时改那两处）。 */
export const EXIT_AWAITING_APPROVAL = 6;

export function exitCodeOf(outcome: CliOutcomeLike): number {
  /* 先判等批：它可能同时 ok=true（这一轮没失败，只是停下了） */
  if (outcome.awaitingApproval) return EXIT_AWAITING_APPROVAL;
  if (!outcome.ok && !outcome.aborted) {
    if (outcome.state === "paused") return 4;
    return 1;
  }
  return 0;
}
