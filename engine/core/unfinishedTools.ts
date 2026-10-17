import { toolLabel, type ToolTrace } from "../../shared/agentTools";

/**
 * 「调用了一半、没有结果」的工具留痕（U09，2026-10-18）。
 *
 * 进程被杀时，日志里那条 `tool-call` 没有配对的 `tool-result`。
 * 恢复时**不能把它丢掉**：用户会看到一个动作凭空消失，而磁盘上可能已经写了一半。
 * 也不能说它成功或失败 —— 我们**不知道**。所以写"结果未知"，并保留参数
 * （用户至少要能看出它当时想做什么）。
 *
 * 抽成独立文件：`events.ts` 顶着 900 行结构上限，而这段是纯函数。
 */
export function unknownToolTraces(
  waiting: ReadonlyArray<{ toolCallId: string; name: string; input?: unknown }>,
): ToolTrace[] {
  return waiting.map((w) => ({
    toolCallId: w.toolCallId,
    name: w.name,
    ok: false,
    line: `⚙ ${toolLabel(w.name)}：结果未知（进程中断时这次调用还在执行）`,
    ...(w.input === undefined ? {} : { input: w.input }),
  }));
}
