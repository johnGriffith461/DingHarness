import type { ConfirmMode } from "@shared/ipc";
import type { ToolTrace } from "@shared/agentTools";

/**
 * F-04：**确认疲劳的逃生门**（2026-10-20）。
 *
 * ## 依据
 *
 * 第一小时放弃的头号触发点是权限疲劳（"点第 80 次之后就开始闭眼按允许"）。
 * 行业里没有默认档共识，但中间档是共识（Claude `acceptEdits` / Gemini `auto_edit` /
 * ZCode「自动编辑文件」）—— 我们上一轮已经加了「接受编辑」。
 * 缺的不是档位，是**被烦到的时候有没有出口**：用户得去设置里找，而那一步没人走。
 *
 * ## 口径
 *
 * - 同一个任务里第 **3** 次出现待批的**编辑类**工具时提示一次；
 * - 只在「按需确认」「每步确认」两档提示（已经是「接受编辑」「全部允许」就不必）；
 * - 每段任务只提示一次（点哪个按钮都算"已提示"）；
 * - 换任务归零 —— 计数按任务算，不做全局"烦了就一直放开"。
 */

/** 编辑类工具（与 `engine/core/editGuard.ts` 的 `isEditToolName` 同一名单）。 */
export const EDIT_TOOL_NAMES = ["write_file", "edit_file", "apply_patch"] as const;

export function isEditToolName(name: string): boolean {
  return (EDIT_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * 这段任务里**累计问过几次编辑**。
 *
 * 口径是"编辑类工具留痕的条数"：默认档下每一次编辑都会先落一条 `pending`，
 * 用户批准后同一条留痕保留（`pending` 变 false），所以它同时数到了"问过"与"批过"。
 * （「接受编辑」档下编辑不再问 —— 那时 `shouldOfferBulkAccept` 本来就不提示。）
 */
export function countEditAsks(steps: ReadonlyArray<{ tools?: ToolTrace[] }>): number {
  let count = 0;
  for (const step of steps) {
    for (const trace of step.tools ?? []) {
      if (isEditToolName(trace.name)) count += 1;
    }
  }
  return count;
}

/** 现在有没有"待批的编辑类工具"（没有就不该弹逃生门建议）。 */
export function hasPendingEdit(steps: ReadonlyArray<{ tools?: ToolTrace[] }>): boolean {
  return steps.some((step) => (step.tools ?? []).some((t) => t.pending === true && isEditToolName(t.name)));
}

/**
 * 该不该提示「本会话自动接受编辑」。
 *
 * @param input.editsAsked 这段任务里累计问过的编辑次数（`countEditAsks`）
 * @param input.alreadyOffered 这段任务已经提示过 / 用户已做过选择
 * @param input.mode 当前确认档位
 */
export function shouldOfferBulkAccept(input: {
  editsAsked: number;
  alreadyOffered: boolean;
  mode: ConfirmMode;
}): boolean {
  if (input.alreadyOffered) return false;
  if (input.mode !== "按需确认" && input.mode !== "每步确认") return false;
  return input.editsAsked >= 3;
}

/** 点「本会话自动接受」时给用户看的那句留痕（也是日志里"谁改的、为什么"）。 */
export const BULK_ACCEPT_NOTE =
  "已把本会话的确认档位切成「接受编辑」（你点了确认卡上的逃生门；命令仍会逐条问你，重启后恢复默认）。";

/** 用户选「继续逐次问」时留在卡片上的话（不再反复建议）。 */
export const KEEP_ASKING_NOTE = "好，这一段继续逐次问。";
