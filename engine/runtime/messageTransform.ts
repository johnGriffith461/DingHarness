import type { ModelInputFormat } from "./modelConfig";

/**
 * **消息形态的转换**（T0）：多模态输入 + 对话中系统消息。
 *
 * ## 两件事，都必须在**发请求之前**判
 *
 * 1. **模态**：用户给了图，而模型没声明图片输入 → 在发请求前报一句人话，
 *    而不是把它降级成 "[图片]" 文本。降级的后果是模型照着空壳回答，
 *    用户却以为它看过图了 —— 这是最难查的一类错。
 * 2. **中途 system**：有的协议允许消息流里出现 system，有的不允许。
 *    允许就原样透传；不允许就转成带标记的 user 文本（**不丢内容**）。
 *
 * ## 为什么直接产出 AI SDK 的 part 形状
 *
 * `image` → `{type:"image"}`；`file`/PDF → `{type:"file"}`；
 * `video` → `{type:"file", mediaType:"video/*"}`（AI SDK 没有单独的 video part）。
 * 不自己发明第四套形状：转成 SDK 认的那一种，中间的形态差异就只有这一处。
 */

/** 一条消息里的内容片段（Ding 侧的自有形状）。 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mediaType: string }
  | { type: "file"; data: string; mediaType: string; filename?: string }
  | { type: "video"; data: string; mediaType: string; filename?: string };

/** 送进 AI SDK 的 part（只用到这三种）。 */
export type AiPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string; mediaType: string }
  | { type: "file"; data: string; mediaType: string; filename?: string };

/** 模态校验失败时的那句话（可读、指出怎么改）。 */
export class ModalityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModalityError";
  }
}

/**
 * 校验并转换一条消息的内容片段。
 *
 * @param parts 用户给的内容
 * @param format 模型声明的输入模态
 * @returns AI SDK 的 part 数组
 * @throws ModalityError 模型没声明这种输入
 */
export function toAiParts(parts: readonly ContentPart[], format: ModelInputFormat): AiPart[] {
  const out: AiPart[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "text":
        out.push({ type: "text", text: part.text });
        break;
      case "image":
        if (!format.supportsImage) {
          throw new ModalityError(
            "当前模型未声明图片输入 —— 在「设置 → 模型 → 编辑模型」里勾上「图片」，或换一个支持图片的模型。",
          );
        }
        out.push({ type: "image", image: part.data, mediaType: part.mediaType });
        break;
      case "file":
        if (part.mediaType === "application/pdf" && !format.supportsPdf) {
          throw new ModalityError(
            "当前模型未声明 PDF 输入 —— 在「设置 → 模型 → 编辑模型」里勾上「PDF」，或换一个支持 PDF 的模型。",
          );
        }
        out.push({
          type: "file",
          data: part.data,
          mediaType: part.mediaType,
          ...(part.filename === undefined ? {} : { filename: part.filename }),
        });
        break;
      case "video":
        if (!format.supportsVideo) {
          throw new ModalityError(
            "当前模型未声明视频输入 —— 视频在各家协议上的支持差异很大；勾选后仍会在保存配置时按协议再校验一次。",
          );
        }
        /* video 用 file part + video/* mediaType 表达（AI SDK 没有单独的 video part） */
        out.push({
          type: "file",
          data: part.data,
          mediaType: part.mediaType || "video/mp4",
          ...(part.filename === undefined ? {} : { filename: part.filename }),
        });
        break;
    }
  }
  return out;
}

/** 一条待发消息。 */
export type OutgoingMessage = {
  role: "system" | "user" | "assistant";
  content: string | readonly ContentPart[];
};

/** 转换后的一条消息。 */
export type TransformedMessage = {
  role: "system" | "user" | "assistant";
  content: string | readonly AiPart[];
};

/**
 * 对话中系统消息的规整。
 *
 * - 协议支持（`supportsMidConversationSystem`）：**原样透传**，靠 SDK 的
 *   `allowSystemInMessages` 送到上游；
 * - 不支持：把中途的 system 折成一条带标记的 user 文本。
 *   标记里写明"这是系统说明"，读起来不至于像用户自己说的话。
 *
 * ⚠️ 第一条 system（真正的前置系统提示）**不算中途**：那一条由
 * `streamText({ system })` 单独送，不在这里处理。
 *
 * @param messages 消息列表（第 0 条如果是 system 会被视为前置提示，原样留下）
 * @param supports 协议是否支持对话中系统消息
 */
export function normalizeMidConversationSystem(
  messages: readonly OutgoingMessage[],
  supports: boolean,
): OutgoingMessage[] {
  if (supports) return [...messages];
  const out: OutgoingMessage[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "system" || index === 0) {
      out.push(message);
      return;
    }
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => (part.type === "text" ? part.text : "[附件]"))
            .join("\n");
    out.push({ role: "user", content: `[系统说明]\n${text}` });
  });
  return out;
}

/**
 * OpenAI 兼容协议的系统消息规整。
 *
 * 这类端点对"系统消息出现在中间"的处理各家不一：有的直接 400，
 * 有的静默丢掉。统一成 user 文本是最稳的做法 —— 内容一个字都不丢，
 * 只是换了个说话的位置。
 */
export function normalizeOpenAiCompatibleSystemMessages(
  messages: readonly OutgoingMessage[],
): OutgoingMessage[] {
  return normalizeMidConversationSystem(messages, false);
}

/** 消息里有没有非文本内容（决定要不要走 part 数组那条路）。 */
export function hasRichContent(message: OutgoingMessage): boolean {
  return typeof message.content !== "string" && message.content.length > 0;
}

/** 统计一条消息里的模态（给"这次请求需要哪些能力"的校验用）。 */
export function modalitiesOf(message: OutgoingMessage): Set<ContentPart["type"]> {
  if (typeof message.content === "string") return new Set(["text"]);
  return new Set(message.content.map((part) => part.type));
}

/**
 * 整批消息的模态校验（在发请求**之前**一次性判完）。
 *
 * 逐条判会在"第 3 条才炸"时白花钱；一次性判完再发，才是省钱的做法。
 */
export function assertModalities(messages: readonly OutgoingMessage[], format: ModelInputFormat): void {
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    toAiParts(message.content, format); // 抛即失败
  }
}
