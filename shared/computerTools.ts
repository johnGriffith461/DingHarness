import { z } from "zod";

import type { AgentToolSpec } from "./agentTools";

/**
 * Computer Use 的工具声明（V6-2n）。
 *
 * 从 `agentTools.ts` 拆出来（结构守卫：那个文件撞了 900 行）。
 * 内容与语义没变 —— 工具名、schema、给模型看的说明都只在这一份里。
 */

export const COMPUTER_SCREENSHOT_TOOL = "computer_screenshot";
export const COMPUTER_CLICK_TOOL = "computer_click";
export const COMPUTER_TYPE_TOOL = "computer_type";
export const COMPUTER_KEY_TOOL = "computer_key";

export const COMPUTER_SCREENSHOT_INPUT = z.object({}).describe("不需要参数");

export const COMPUTER_CLICK_INPUT = z.object({
  x: z.number().int().min(0).describe("屏幕横坐标（像素）"),
  y: z.number().int().min(0).describe("屏幕纵坐标（像素）"),
  button: z.enum(["left", "right"]).optional().describe("鼠标键，默认左键"),
});

export const COMPUTER_TYPE_INPUT = z.object({
  text: z.string().min(1).max(4000).describe("要输入的文字（走剪贴板粘贴，支持中文与换行）"),
});

export const COMPUTER_KEY_INPUT = z.object({
  key: z.string().min(1).describe("按键名（enter / tab / escape / ctrl+a / alt+tab …，白名单见 computer.ts）"),
});

const HEAD =
  "操作**真实桌面**。需要用户在「权限矩阵」页授权，且每一次动作都经审批；" +
  "成功与被拒都会留痕（输入的文字不记录）。不要用它代替普通文件工具。";

export const COMPUTER_SCREENSHOT_DESC = `${HEAD}\n截取当前主屏幕，返回落盘路径与尺寸（界面可预览）。`;
export const COMPUTER_CLICK_DESC = `${HEAD}\n在屏幕坐标 (x, y) 点一下（先想清楚坐标从哪来：截图后按比例估算，别乱点）。`;
export const COMPUTER_TYPE_DESC = `${HEAD}\n把一段文字输入到当前焦点（单次 ≤4000 字符）。`;
export const COMPUTER_KEY_DESC = `${HEAD}\n按一个键或组合键（白名单：enter/tab/escape/方向键/ctrl+a…；不支持任意字符串）。`;

/** 注册表吃的那四条（顺序即注入顺序）。 */
export const COMPUTER_TOOL_SPECS: readonly AgentToolSpec[] = [
  { name: COMPUTER_SCREENSHOT_TOOL, description: COMPUTER_SCREENSHOT_DESC, schema: COMPUTER_SCREENSHOT_INPUT },
  { name: COMPUTER_CLICK_TOOL, description: COMPUTER_CLICK_DESC, schema: COMPUTER_CLICK_INPUT },
  { name: COMPUTER_TYPE_TOOL, description: COMPUTER_TYPE_DESC, schema: COMPUTER_TYPE_INPUT },
  { name: COMPUTER_KEY_TOOL, description: COMPUTER_KEY_DESC, schema: COMPUTER_KEY_INPUT },
];
