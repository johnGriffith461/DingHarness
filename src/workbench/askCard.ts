/**
 * P0-07：把 `ask_user` 的工具结果映射成**问题卡**。
 *
 * 这里是"工具结果 → 卡片"的唯一映射；`nextStep` 用它，测试也用它，
 * 不让界面各写一份字段翻译。
 */

import type { ToolTrace } from "@shared/agentTools";
import { askFromOutput } from "@engine/runtime/tools/askUserTool";
import type { AskRequest } from "@engine/runtime/tools/askUserTool";
import type { TaskQuestion } from "./task";

/** 一条 `ask_user` 结果 → 一张问题卡。 */
export function questionFromAsk(ask: AskRequest): TaskQuestion {
  return {
    id: `ask-${Date.now().toString(36)}`,
    text: ask.question,
    options: ask.options.map((o) => ({ label: o.label, hint: o.description ?? "" })),
    source: "ask_user",
  };
}

/** 从这一步的工具留痕里取**最后一条**成功的 `ask_user`（没有就空）。 */
export function askQuestionsFromTraces(traces: readonly ToolTrace[]): TaskQuestion[] {
  for (let i = traces.length - 1; i >= 0; i -= 1) {
    const t = traces[i];
    if (!t || t.name !== "ask_user" || t.ok !== true) continue;
    const ask = askFromOutput(t.output);
    if (ask) return [questionFromAsk(ask)];
  }
  return [];
}
