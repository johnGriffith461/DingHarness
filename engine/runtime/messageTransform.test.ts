import { describe, expect, it } from "vitest";

import {
  ModalityError,
  assertModalities,
  normalizeMidConversationSystem,
  normalizeOpenAiCompatibleSystemMessages,
  toAiParts,
  type ContentPart,
} from "./messageTransform";
import { TEXT_ONLY_INPUT, type ModelInputFormat } from "./modelConfig";

/**
 * 多模态与中途 system 的转换（T0）。
 *
 * 核心不是"能转"，是**能力不足时在发请求之前报错**：
 * 把图片降级成 "[图片]" 文本，模型会照着空壳回答，而用户以为它看过图了。
 */

const TEXT: ModelInputFormat = TEXT_ONLY_INPUT;
const FULL: ModelInputFormat = {
  supportsText: true,
  supportsImage: true,
  supportsVideo: true,
  supportsAudio: false,
  supportsPdf: true,
};

const imagePart: ContentPart = { type: "image", data: "AAA", mediaType: "image/png" };
const pdfPart: ContentPart = { type: "file", data: "BBB", mediaType: "application/pdf", filename: "a.pdf" };
const videoPart: ContentPart = { type: "video", data: "CCC", mediaType: "video/mp4" };

describe("模态转换", () => {
  it("文本原样通过", () => {
    expect(toAiParts([{ type: "text", text: "hi" }], TEXT)).toEqual([{ type: "text", text: "hi" }]);
  });

  it("图片 → image part（能力为真时）", () => {
    expect(toAiParts([imagePart], FULL)).toEqual([{ type: "image", image: "AAA", mediaType: "image/png" }]);
  });

  it("PDF → file part（带 filename）", () => {
    expect(toAiParts([pdfPart], FULL)).toEqual([
      { type: "file", data: "BBB", mediaType: "application/pdf", filename: "a.pdf" },
    ]);
  });

  it("视频 → file part + video/* mediaType（AI SDK 没有单独的 video part）", () => {
    expect(toAiParts([videoPart], FULL)).toEqual([
      { type: "file", data: "CCC", mediaType: "video/mp4" },
    ]);
  });

  it("模型没声明图片 → 抛错并说清怎么改", () => {
    expect(() => toAiParts([imagePart], TEXT)).toThrow(ModalityError);
    expect(() => toAiParts([imagePart], TEXT)).toThrow(/勾上「图片」/);
  });

  it("模型没声明 PDF → 抛错", () => {
    expect(() => toAiParts([pdfPart], TEXT)).toThrow(/PDF/);
  });

  it("模型没声明视频 → 抛错", () => {
    expect(() => toAiParts([videoPart], TEXT)).toThrow(/视频/);
  });
});

describe("整批预校验（发请求前一次判完）", () => {
  it("合法消息不抛", () => {
    expect(() =>
      assertModalities(
        [
          { role: "user", content: "纯文本" },
          { role: "user", content: [{ type: "text", text: "看图" }, imagePart] },
        ],
        FULL,
      ),
    ).not.toThrow();
  });

  it("**第二条**才不合法时，也在发请求前就抛（不能等到发出去才炸）", () => {
    let threw = false;
    try {
      assertModalities(
        [
          { role: "user", content: "第一条没问题" },
          { role: "user", content: [imagePart] },
        ],
        TEXT,
      );
    } catch {
      threw = true;
    }
    expect(threw, "第二条的模态问题没有在预校验阶段暴露").toBe(true);
  });

  it("纯字符串内容全部跳过（不走 part 那条路）", () => {
    expect(() => assertModalities([{ role: "user", content: "hi" }], TEXT)).not.toThrow();
  });
});

describe("对话中系统消息", () => {
  const messages = [
    { role: "system" as const, content: "你是助手" },
    { role: "user" as const, content: "第一问" },
    { role: "system" as const, content: "补充要求：用中文" },
    { role: "assistant" as const, content: "好的" },
  ];

  it("协议支持时原样透传（一条都不改）", () => {
    expect(normalizeMidConversationSystem(messages, true)).toEqual(messages);
  });

  it("协议不支持时把中途 system 折成带标记的 user 文本，内容不丢", () => {
    const out = normalizeMidConversationSystem(messages, false);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ role: "system", content: "你是助手" }); // 首条 system 不动
    expect(out[2]).toEqual({ role: "user", content: "[系统说明]\n补充要求：用中文" });
  });

  it("OpenAI 兼容那条一律折（该协议对中途 system 各家不一）", () => {
    expect(normalizeOpenAiCompatibleSystemMessages(messages)[2]).toEqual({
      role: "user",
      content: "[系统说明]\n补充要求：用中文",
    });
  });

  it("中途 system 是 part 数组时，附件用占位文字代替（不丢条数）", () => {
    const out = normalizeMidConversationSystem(
      [
        { role: "user", content: "q" },
        { role: "system", content: [{ type: "text", text: "看这个" }, imagePart] },
      ],
      false,
    );
    expect(out[1]).toEqual({ role: "user", content: "[系统说明]\n看这个\n[附件]" });
  });
});
