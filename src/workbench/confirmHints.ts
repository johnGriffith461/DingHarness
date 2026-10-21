import type { ConfirmMode } from "@shared/ipc";

/**
 * 四档确认的**一句话说明**（2026-10-22）。
 *
 * 口径与 `engine/core/policy.ts` 的 `modeRank` / `decide` 一致，只在这里写一份 ——
 * 界面上的解释与判定实现分开写，语义一改两处必须一起改（`confirmMode.test.ts`
 * 盯着档位本身，这里只是给用户的说法）。
 */
export const CONFIRM_HINT: Record<ConfirmMode, string> = {
  全部允许: "不再问，工具直接执行",
  接受编辑: "改文件不问；跑命令、连外部仍然问",
  按需确认: "读放行；写文件、跑命令先问你",
  每步确认: "每一次工具调用都先问你",
};
