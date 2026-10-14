import { AGENT_TOOLS } from "../../shared/agentTools";
import type { ConfirmMode } from "../../shared/ipc";

/**
 * **错误回注的三件套**（Factor 9：把错误压缩进上下文，而不是抛栈）。
 *
 * ## 为什么它们必须住在一起
 *
 * "工具出错时模型看见什么"一共只有三种情形：
 *
 * | 情形 | 什么时候发生 | 模型该学到什么 |
 * |---|---|---|
 * | 未知工具 | 模型调了一个不存在的名字 | 没有这个工具 + **可用的有哪些** |
 * | 闸门拦截 | 用户档位要求确认，调用**没有执行** | 没执行、在等谁、**别再试** |
 * | 执行失败 | 工具自己报错（路径不在白名单、命令超时…） | 失败了 + 原因 |
 *
 * 它们原来各自散在三个文件里：`shared/agentTools.ts`（未知工具）、
 * `engine/core/policy.ts`（闸门）、以及"失败"根本没有一句自己的话 ——
 * 失败是执行体随手 `new Error(...)` 抛出来的。
 *
 * 后果不是"不好看"，是**两个宿主会对同一件事说不同的话**：
 * 桌面点"允许"后失败给一句、CLI 里失败给另一句，模型据此学到的行为也不一样。
 * 收在一起之后，"模型看见的错误"这件事只有这一个文件能改。
 *
 * ## 三句话各自的硬要求（单测盯着）
 *
 * - 未知工具：**要列出可用工具**，否则模型只会换个名字继续猜；
 * - 闸门拦截：要同时说清"没执行"与"别重试" —— 少了前者用户以为事做完了，
 *   少了后者模型会在同一轮里反复试同一个工具；
 * - 执行失败：`name` 与 `reason` 都要出现（只说"失败了"等于没说）。
 *
 * ⚠️ 这些话是**给模型看的**，不是给用户看的。界面上那一行由
 * `shared/agentTools.ts` 的 `describeToolResult` 生成 —— 那是另一件事，别混。
 */

/**
 * 模型调了一个不存在的工具。
 *
 * @param name 它调的那个名字
 * @param reason 可选的更具体原因（例如 schema 校验失败的信息）
 * @returns 一句话
 */
export function unknownToolNotice(name: string, reason?: string): string {
  const known = AGENT_TOOLS.map((t) => t.name).join(" / ");
  const head = `没有名为「${name}」的工具。可用工具：${known}。`;
  return reason ? `${head}（参数问题：${reason}）请修正后重试。` : `${head}请改用其中一个。`;
}

/**
 * 这次调用被闸门拦下、**还没有执行**。
 *
 * @param name 工具名
 * @param mode 当前档位
 * @returns 一句话
 */
export function pendingApprovalNotice(name: string, mode: ConfirmMode): string {
  return `已把这次「${name}」交给用户确认（当前档位：${mode}），**还没有执行**。请不要重试，直接把需要确认的事告诉用户。`;
}

/**
 * 工具执行失败。
 *
 * ⚠️ 它的形状是**透传**：执行体自己给的那句原因（"这个路径不在可读写范围内"）
 * 原样保留，只在执行体没给原因时补一句兜底。这样做的理由很实际 ——
 * 各工具那句原因是**它们自己最清楚**的事（比如"能写的范围是哪些"），
 * 在这里统一改写只会把有用的信息洗掉。
 *
 * @param name 工具名
 * @param reason 执行体给的原因（可能没有）
 * @returns 一句话
 */
export function toolFailedNotice(name: string, reason?: string): string {
  const detail = (reason ?? "").trim();
  return detail || `「${name}」执行失败（没有给出原因）。`;
}
