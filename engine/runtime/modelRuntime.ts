import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import type { ToolSet } from "ai";

import type { Protocol } from "./models";
import type { ResolvedModelConfig } from "./modelConfig";

/**
 * **模型声明的运行时视图**（T0）。
 *
 * 直接用解析结果，不另造一份：两份类型会在"加了一个字段忘了同步"时
 * 静默分叉（界面上有、请求里没有 —— 那正是"假控件"）。
 */
export type RuntimeModelConfig = ResolvedModelConfig;

/** 原生联网搜索的注入结果。 */
export type NativeSearchInjection = {
  /** 要并进 `tools` 的那一项。 */
  tools: ToolSet;
  /** 给人看的名字（日志/事件里用）。 */
  label: string;
};

/**
 * 按协议造"原生联网搜索"工具。
 *
 * ## 为什么只有两家
 *
 * - Anthropic 有 `webSearch_20260209`（服务端执行，结果回灌进上下文）；
 * - Google 有 `googleSearch`（grounding）。
 * - **OpenAI 兼容协议没有**：那是一堆不同实现的集合（官方、中转、本地推理），
 *   没有任何一个"原生搜索"能被这个协议统一表达。
 *
 * 所以 OpenAI 兼容**不注入**，并且这个"不支持"要在**保存配置时**就告诉用户
 * （见 `validateCapabilityForProtocol`），而不是发了请求才发现没效果。
 *
 * @param protocol 协议
 * @returns 要注入的工具（不支持的协议返回 `undefined`）
 */
export function nativeSearchToolFor(protocol: Protocol): NativeSearchInjection | undefined {
  switch (protocol) {
    case "anthropic":
      return {
        label: "Anthropic 原生联网搜索",
        tools: {
          web_search: anthropic.tools.webSearch_20260209({ maxUses: 8 }),
        } as unknown as ToolSet,
      };
    case "google":
      return {
        label: "Google 原生联网搜索",
        tools: {
          google_search: google.tools.googleSearch({}) as never,
        } as unknown as ToolSet,
      };
    default:
      return undefined;
  }
}

/**
 * 保存配置时校验"这个协议能不能支持用户勾的能力"。
 *
 * ⚠️ **提前报错**是刻意的：`supportsNativeWebSearch` 勾了但协议不支持，
 * 发请求时无任何效果 —— 用户会以为"联网搜索开着"，其实没有。
 * 这种"静默不生效"比直接拒绝保存坏得多。
 *
 * @param protocol 协议
 * @param config 解析后的配置
 * @returns 错误消息（`null` = 可以保存）
 */
export function validateCapabilityForProtocol(
  protocol: Protocol,
  config: Pick<ResolvedModelConfig, "supportsNativeWebSearch" | "inputFormat">,
): string | null {
  if (config.supportsNativeWebSearch && !nativeSearchToolFor(protocol)) {
    return "当前协议（OpenAI 兼容）不支持原生联网搜索 —— 换 Anthropic / Google 原生协议，或取消这一项";
  }
  if (config.inputFormat.supportsVideo && protocol === "anthropic") {
    return "Anthropic 协议不支持视频输入（官方 API 不接受）—— 取消「视频」或换一个支持视频的协议";
  }
  return null;
}
