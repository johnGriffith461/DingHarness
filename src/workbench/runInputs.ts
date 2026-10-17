import type { ConfirmMode } from "@shared/ipc";

/**
 * 一轮请求的**附加输入**（L05/L06 收口，2026-10-18）。
 *
 * 从 `taskRuntime.ts` 抽出来（那个文件顶着 900 行上限）。这里只有两件纯逻辑：
 * 档位取严、技能提示；都不碰 store，好单测。
 */

/**
 * 取两个档位里**更严**的那个。
 *
 * 严格度：每步确认 > 按需确认 > 全部允许。
 *
 * 为什么：档位是用户选的旋钮，智能体是角色 —— 角色只能让门更紧，
 * 不能替用户把门放开（与工作流步骤"只能更严"同一条口径）。
 *
 * @param user 用户当前选的档位
 * @param agent 智能体声明的档位（可能没有）
 */
export function stricterMode(user: ConfirmMode, agent?: ConfirmMode): ConfirmMode {
  const rank: Record<ConfirmMode, number> = { 全部允许: 0, 按需确认: 1, 每步确认: 2 };
  if (!agent) return user;
  return rank[agent] > rank[user] ? agent : user;
}

/**
 * 这一轮的技能提示（G08）：**走主进程**读技能目录（渲染层没有 fs）。
 *
 * 失败/没配就返回空串 —— 技能是增强，不该让一轮跑不起来。
 *
 * @param text 用户这一轮说的话
 */
export async function skillsBlockFor(text: string): Promise<string> {
  const shell = (globalThis as unknown as { shell?: { skills?: { block: (t: string) => Promise<string> } } }).shell;
  try {
    return (await shell?.skills?.block?.(text)) ?? "";
  } catch {
    return "";
  }
}
