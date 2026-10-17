import { z } from "zod";

import type { AgentToolSpec } from "./agentTools";
import { UIA_ACTIONS } from "./uia";

/**
 * **元素定位版 Computer Use 的工具声明**（G05，2026-10-18）。
 *
 * 与坐标版（`computerTools.ts`）的分工：
 * - 坐标版：任何界面都能点，但要截图估算、且抢焦点；
 * - 元素版：只对**有 UIA 树**的应用有效（记事本/计算器/大多数 Win32 与 WPF 程序），
 *   但**不抢焦点**、点的是"那个按钮"而不是"那个像素"。
 *
 * 两条都留着：模型先试元素版（更稳），找不到再用坐标版。
 */

export const COMPUTER_WINDOWS_TOOL = "computer_windows";
export const COMPUTER_ELEMENTS_TOOL = "computer_elements";
export const COMPUTER_INVOKE_TOOL = "computer_invoke";

const HEAD =
  "用 **UI Automation 元素树** 操作真实窗口（不靠坐标）。需要用户在「权限矩阵」页授权电脑操作；" +
  "每次动作都过审批并留痕（输入的文字不记录）。";

export const COMPUTER_WINDOWS_INPUT = z.object({}).describe("不需要参数");

export const COMPUTER_ELEMENTS_INPUT = z.object({
  window: z.string().trim().optional().describe("窗口标题（可只给一部分）；省略 = 当前前台窗口"),
  max: z.number().int().min(10).max(400).optional().describe("最多枚举多少个元素，默认 200"),
});

export const COMPUTER_INVOKE_INPUT = z.object({
  window: z.string().trim().optional().describe("窗口标题（与取快照时同一个）；省略 = 前台窗口"),
  ref: z.string().trim().min(1).describe("快照里的元素索引（形如 #3）"),
  action: z.enum(UIA_ACTIONS as unknown as [string, ...string[]]).describe("动作：invoke / setValue / toggle / focus / expand"),
  text: z.string().max(4000).optional().describe("setValue 时要写入的文字"),
});

export const COMPUTER_WINDOWS_DESC = `${HEAD}\n列出当前可操作的窗口（标题 + 进程名）。先看有哪些窗口，再取元素树。`;
export const COMPUTER_ELEMENTS_DESC = `${HEAD}\n取一个窗口的**紧凑元素树**：每个可操作控件一个稳定的 \`#N\` 索引、控件类型、可访问名、支持的动作。\n不抢焦点（后台窗口也能枚举）。动手之前先取这个，别猜坐标。`;
export const COMPUTER_INVOKE_DESC = `${HEAD}\n对一个元素执行动作：invoke（点按钮）/ setValue（写输入框）/ toggle（勾选）/ focus / expand。\n索引来自快照；窗口变了就重新取一次。`;

/** 注册表吃的那三条。 */
export const UIA_TOOL_SPECS: readonly AgentToolSpec[] = [
  { name: COMPUTER_WINDOWS_TOOL, description: COMPUTER_WINDOWS_DESC, schema: COMPUTER_WINDOWS_INPUT },
  { name: COMPUTER_ELEMENTS_TOOL, description: COMPUTER_ELEMENTS_DESC, schema: COMPUTER_ELEMENTS_INPUT },
  { name: COMPUTER_INVOKE_TOOL, description: COMPUTER_INVOKE_DESC, schema: COMPUTER_INVOKE_INPUT },
];

/** 是不是元素版工具（策略表按它判）。 */
export function isUiaTool(name: string): boolean {
  return name === COMPUTER_WINDOWS_TOOL || name === COMPUTER_ELEMENTS_TOOL || name === COMPUTER_INVOKE_TOOL;
}
