import type { ConfirmMode } from "@shared/ipc";
import { MEMBER_ROLES, type MemberRole } from "@engine/core/members";
import { TOOL_POLICY, decideForMember, policyOf } from "@engine/core/policy";

/**
 * 两轴权限矩阵的**可渲染形状**（V6-2i / V6-4d）。
 *
 * 内核早就有 `decideForMember`（ADR-0007 的落点），但产品面只有零散的
 * "档位 chip / 角色下拉 / 审批卡"—— 用户看不到**整张表**。
 * 这里只做一件事：把内核的判定逐格问一遍，拼成表格。
 *
 * ⚠️ **不复制判定**：每一格都调 `decideForMember`。自己写一份"viewer 不能写"
 * 之类的规则，迟早会与内核分叉 —— 而分叉的方向通常是界面变松。
 */

export type Verdict = "run" | "ask" | "hide" | "deny";

export type MatrixRow = {
  tool: string;
  kind: "read" | "write";
  cells: Record<MemberRole, Verdict>;
};

/** 给人看的判定名（与内核词表一致，不另造词）。 */
export const VERDICT_LABEL: Record<Verdict, string> = {
  run: "放行",
  ask: "要确认",
  hide: "不给模型",
  deny: "直接拒",
};

/** 一格的说明（悬停用；说清"为什么"，不是重复判定名）。 */
export function verdictHint(verdict: Verdict, role: MemberRole, kind: "read" | "write"): string {
  if (verdict === "hide") return "工具没注入给模型 —— 与谁在用无关";
  if (verdict === "deny") return `${role === "viewer" ? "只读成员" : "这个角色"}不能做写操作：直接拒，不交给审批（批了也不该生效）`;
  if (verdict === "ask") return "工具轴要求确认：这一次调用要用户/审批人点头";
  return kind === "read" ? "只读操作，档位与人轴都放行" : "写操作，但当前档位与角色都允许";
}

/**
 * 按档位拼出整张矩阵。
 *
 * @param mode 工具档位
 * @returns 每行一个工具；列是四个角色（顺序固定）
 */
export function matrixRows(mode: ConfirmMode): MatrixRow[] {
  return Object.keys(TOOL_POLICY)
    .sort((a, b) => {
      const kindA = policyOf(a).kind;
      const kindB = policyOf(b).kind;
      if (kindA !== kindB) return kindA === "read" ? -1 : 1;
      return a.localeCompare(b);
    })
    .map((tool) => {
      const kind = policyOf(tool).kind;
      const cells = {} as Record<MemberRole, Verdict>;
      for (const role of MEMBER_ROLES) {
        cells[role] = decideForMember({ roles: [role] }, mode, tool).verdict;
      }
      return { tool, kind, cells };
    });
}
