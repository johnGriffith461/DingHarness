import { describe, expect, it } from "vitest";

import { askQuestionsFromTraces, questionFromAsk } from "./askCard";
import type { ToolTrace } from "@shared/agentTools";

/**
 * P0-07：`ask_user` 的 tool-result → 问题卡。
 *
 * 判据：一条成功的 ask_user 结果映射成一张卡（选项按 description 收窄成 hint）；
 * 失败/被拒/普通工具都不产生卡。
 */
describe("questionFromAsk", () => {
  it("映射问题、选项与 hint", () => {
    const q = questionFromAsk({
      question: "用哪个包管理器？",
      options: [
        { label: "pnpm", description: "快" },
        { label: "npm" },
      ],
      allowFreeText: true,
    });
    expect(q.text).toContain("包管理器");
    expect(q.options[0]).toEqual({ label: "pnpm", hint: "快" });
    expect(q.options[1]).toEqual({ label: "npm", hint: "" });
    expect(q.source).toBe("ask_user");
  });
});

describe("askQuestionsFromTraces", () => {
  const ok: ToolTrace = {
    toolCallId: "c1",
    name: "ask_user",
    ok: true,
    line: "已向用户提问",
    output: {
      ask: {
        question: "要继续吗？",
        options: [{ label: "继续" }, { label: "停" }],
        allowFreeText: true,
      },
    },
  };

  it("成功结果映射成一张卡", () => {
    expect(askQuestionsFromTraces([ok])).toHaveLength(1);
  });

  it("失败结果不产生卡", () => {
    expect(askQuestionsFromTraces([{ ...ok, ok: false, error: "bad" }])).toEqual([]);
  });

  it("普通工具不产生卡", () => {
    expect(askQuestionsFromTraces([{ ...ok, name: "read_file" }])).toEqual([]);
  });
});
