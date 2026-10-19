import { createOpenAI } from "@ai-sdk/openai";

import type { ProtocolAdapter } from "./types";

/**
 * **OpenAI Responses API**（`/responses`）协议适配器。
 *
 * ## 为什么它单独算一种协议，而不是"另一种 OpenAI 兼容"
 *
 * Chat Completions 与 Responses 是**两条不同的接口**：
 * - 路径不同（`/chat/completions` vs `/responses`）；
 * - 消息形状不同（Responses 用 `input` 而不是 `messages`，工具与推理的返回结构也不同）；
 * - 有些中转站/厂商**只开其中一条**。
 *
 * 把它们当成同一个"兼容"协议，会在"对方只开了 responses"时发到一条不存在的路径上，
 * 而错误信息是 404 —— 用户很难看出是"格式选错了"。
 *
 * ## 它和另外两种怎么选
 *
 * 由用户在「新供应商」里选（三选一），我们不猜：
 * `/v1/messages` → Anthropic；`/chat/completions` → Chat Completions；`/responses` → 这里。
 */
export const openaiResponses: ProtocolAdapter = {
  id: "openai-responses",
  label: "Responses API",
  createModel: ({ baseURL, apiKey, model, headers, fetch }) =>
    createOpenAI({
      name: "openai",
      ...(baseURL ? { baseURL } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(headers ? { headers } : {}),
      ...(fetch ? { fetch } : {}),
    }).responses(model),
};
