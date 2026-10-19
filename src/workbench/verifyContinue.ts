import { summarizeVerify } from "@engine/runtime/verifyLoop";

/**
 * P0-04：验证结果 → 回注给模型的一条 user 消息。
 *
 * 为什么不是"系统消息偷偷注入"：用户要能看到"跑了什么、结果是什么"，
 * 模型也要能引用它作为完成证据。两者读同一条消息。
 */
export function verificationMessage(input: {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}): string {
  const summary = summarizeVerify({
    exitCode: input.exitCode,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
  });
  const verdict = input.timedOut
    ? "验证超时（命令被中止）"
    : input.exitCode === 0
      ? "验证通过"
      : "验证失败";
  return [
    "【验证结果】",
    `命令：${input.command}`,
    `结果：${verdict}（退出码 ${input.exitCode === null ? "未知" : input.exitCode}）`,
    "输出（尾部）：",
    summary.excerpt,
    "",
    "请根据这个结果继续：通过就以它作为证据收尾（finish）；失败就修根因，不要注释掉测试或伪造输出。",
  ].join("\n");
}
