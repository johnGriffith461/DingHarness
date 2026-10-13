import { describe, expect, it } from "vitest";
import {
  HISTORY_LIMIT,
  TOOL_OUTPUT_LIMIT,
  buildHistory,
  outputText,
  truncatedNote,
  withToolLines,
} from "./history";
import type { ToolTrace } from "@shared/agentTools";
import type { TaskStep } from "./task";

/**
 * 历史组装（§147）。
 *
 * 这一层的存在理由：之前每次请求只发**一条** user 消息，而任务视图里的输入框提交时
 * 调的是 `createTask` —— **在已有对话里继续说话会新建一个任务**，
 * 所以这个应用**根本没有多轮对话**（本体不是这样）。
 */
const step = (role: "user" | "assistant", text: string, id = `${role}-${text}`): TaskStep => ({
  id,
  role,
  text,
  at: 0,
});

describe("buildHistory", () => {
  it("按原顺序（旧 → 新）组装，角色照搬", () => {
    const got = buildHistory([step("user", "甲"), step("assistant", "乙"), step("user", "丙")]);
    expect(got.messages).toEqual([
      { role: "user", content: "甲" },
      { role: "assistant", content: "乙" },
      { role: "user", content: "丙" },
    ]);
    expect(got.truncated).toBe(false);
  });

  it("⭐ 顺序不能反 —— 反过来模型会把因果关系读反（历史上翻过这个坑）", () => {
    const got = buildHistory([step("user", "先说的"), step("assistant", "后说的")]);
    expect(got.messages[0]?.content).toBe("先说的");
    expect(got.messages[1]?.content).toBe("后说的");
  });

  it("空白步骤不发（避免给模型一堆空消息）", () => {
    const got = buildHistory([step("user", "有用"), step("assistant", "   "), step("assistant", "")]);
    expect(got.messages).toHaveLength(1);
  });

  it("首尾空白去掉（模型不该看到行尾空格带来的差异）", () => {
    expect(buildHistory([step("user", "  有内容  ")]).messages[0]?.content).toBe("有内容");
  });

  it("空历史给空数组（第一条消息就是新消息，不该塞占位）", () => {
    expect(buildHistory([]).messages).toEqual([]);
  });

  it(`超过 ${HISTORY_LIMIT} 条只留最近的那些，并标记 truncated`, () => {
    const many = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => step(i % 2 ? "assistant" : "user", `第${i}条`, `s${i}`));
    const got = buildHistory(many);
    expect(got.messages).toHaveLength(HISTORY_LIMIT);
    expect(got.truncated).toBe(true);
    // 留的是**最新**的那批
    expect(got.messages[got.messages.length - 1]?.content).toBe(`第${HISTORY_LIMIT + 4}条`);
    expect(got.messages[0]?.content).toBe(`第5条`);
  });

  it("刚好等于上限时不算截断", () => {
    const exact = Array.from({ length: HISTORY_LIMIT }, (_, i) => step("user", `第${i}条`, `e${i}`));
    expect(buildHistory(exact).truncated).toBe(false);
  });

  it("可以按调用方给的上限裁（便于测试与将来的压缩）", () => {
    const got = buildHistory([step("user", "1"), step("assistant", "2"), step("user", "3")], 2);
    expect(got.messages.map((m) => m.content)).toEqual(["2", "3"]);
    expect(got.truncated).toBe(true);
  });
});

describe("工具留痕折进历史（§148）", () => {
  const trace = (line: string, extra: Partial<ToolTrace> = {}): ToolTrace => ({
    toolCallId: "c1",
    name: "memory_save",
    ok: true,
    line,
    ...extra,
  });

  it("没有工具时原样返回（不能平白多出空括号）", () => {
    expect(withToolLines("普通回复", undefined)).toBe("普通回复");
    expect(withToolLines("普通回复", [])).toBe("普通回复");
  });

  it("⭐ 带上工具结果 —— 否则模型不知道上一轮已经存过/被拒过", () => {
    const got = withToolLines("好，我记住了", [trace("⚙ 记忆：已保存，当前 1 条")]);
    expect(got).toContain("好，我记住了");
    expect(got).toContain("⚙ 记忆：已保存，当前 1 条");
  });

  it("多步工具按顺序用「；」连起来", () => {
    const got = withToolLines("办完了", [trace("⚙ 记忆：已保存"), trace("⚙ 定时任务：已创建「日报」")]);
    expect(got).toContain("⚙ 记忆：已保存；⚙ 定时任务：已创建「日报」");
  });

  it("⭐ 界面上那行字**原样**搬进去（同一件事只有一处措辞）", () => {
    const line = "⚙ 记忆：你已拒绝";
    expect(withToolLines("", [trace(line)])).toContain(line);
  });

  it("空留痕行不参与（避免出现「；；」这种）", () => {
    const got = withToolLines("x", [trace(""), trace("⚙ 记忆：已保存")]);
    expect(got).toContain("⚙ 记忆：已保存");
    expect(got).not.toContain("；；");
  });

  it("正文为空但有工具留痕时，这一步仍然发得出去", () => {
    const got = buildHistory([{ id: "s", role: "assistant", text: "  ", at: 0, tools: [trace("⚙ 记忆：已保存")] }]);
    expect(got.messages).toHaveLength(1);
    expect(got.messages[0]?.content).toContain("本步工具");
  });
});

describe("截断时的说明", () => {
  it("⭐ 必须让模型知道「你看不到全部」 —— 否则它会把「没在上下文里」当成「没发生过」", () => {
    const note = truncatedNote();
    expect(note).toContain(String(HISTORY_LIMIT));
    expect(note).toContain("更早的对话已省略");
    expect(note).toContain("不要猜");
  });
});


describe("工具输出进历史（§163）", () => {
  const trace = (patch: Partial<ToolTrace> = {}): ToolTrace => ({
    toolCallId: "call_1",
    name: "memory_list",
    ok: true,
    line: "⚙ 记忆：已列出 2 条",
    ...patch,
  });

  it("⭐ 输出真的被带上了 —— 上一步工具返回过的东西，这一步模型要看得到", () => {
    const got = withToolLines("好，我看一下。", [
      trace({ output: ["客户叫云帆", "交付日是 11 月 3 日"] }),
    ]);
    expect(got).toContain("客户叫云帆");
    expect(got).toContain("交付日是 11 月 3 日");
  });

  it("界面上那行小字仍在（一行说「做了什么」，输出说「得到了什么」）", () => {
    const got = withToolLines("x", [trace({ output: ["甲"] })]);
    expect(got).toContain("⚙ 记忆：已列出 2 条");
    expect(got).toContain("输出：");
  });

  it("⭐ 还在等审批的**不带输出** —— 它压根没执行，编一段输出会误导", () => {
    const got = withToolLines("x", [trace({ pending: true, output: ["不该出现"] })]);
    expect(got).not.toContain("不该出现");
    expect(got).toContain("⚙ 记忆：已列出 2 条");
  });

  it("没有输出时不留一个空的「输出：」", () => {
    const got = withToolLines("x", [trace()]);
    expect(got).not.toContain("输出：");
  });

  it("对象输出用 JSON 说", () => {
    const got = withToolLines("x", [trace({ output: { saved: true } })]);
    expect(got).toContain('{"saved":true}');
  });

  it("「待确认」信封不算输出（那是审批闸门的内部结构）", () => {
    expect(outputText({ pending: true })).toBe("");
  });

  it("⭐ 超长截断并**注明截断**（不假装完整）", () => {
    const long = "字".repeat(TOOL_OUTPUT_LIMIT + 50);
    const got = outputText(long);
    expect(got.length).toBeLessThanOrEqual(TOOL_OUTPUT_LIMIT + 8);
    expect(got).toContain("已截断");
  });

  it("空白与 null 都给空串", () => {
    expect(outputText(null)).toBe("");
    expect(outputText(undefined)).toBe("");
    expect(outputText("   ")).toBe("");
  });

  it("换行被压成一行（免得把历史撑成多段）", () => {
    expect(outputText("甲\n乙")).toBe("甲 乙");
  });

  it("字符串输出原样用（不套引号）", () => {
    expect(outputText("已保存")).toBe("已保存");
  });

  it("没有工具留痕时正文原样返回（不带括号）", () => {
    expect(withToolLines("就一句话", [])).toBe("就一句话");
  });

  it("只有输出、没有界面文案时也能拼出来（不留空）", () => {
    const got = withToolLines("x", [trace({ line: "", output: "结果" })]);
    expect(got).toContain("结果");
    expect(got).not.toContain("（；");
  });
});
