import { describe, expect, it } from "vitest";
import {
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

  /*
   * ⚠️ C3 改过：**条数不再是判据**。
   *
   * 原来这里断言"超过 20 条只留最近 20 条"——那道硬截断把压缩阈值架空了
   * （20 条短消息远不到 2 万 token，"该压就压"于是几乎永远不触发）。
   * 现在留多少由 `engine/core/context.ts` 的 `planContext` **按 token 额度**决定，
   * 那条规矩本身在 `src/workbench/compaction.test.ts` 里被测（本文件从这里 re-export）。
   *
   * 这里只测**本文件该负责的那段**：把步骤拼成消息、空步骤跳过、折叠工具行、
   * 以及"切了就给 truncated"这个信号。
   */
  it("额度够大时全都留下（本机版常见情形：一段对话远不到额度）", () => {
    const many = Array.from({ length: 60 }, (_, i) => step(i % 2 ? "assistant" : "user", `第${i}条`, `s${i}`));
    const got = buildHistory(many);
    expect(got.messages).toHaveLength(60);
    expect(got.truncated).toBe(false);
  });

  it("⭐ 超出额度时切掉更早的那批，并如实标记 truncated（判据是 token，不是条数）", () => {
    // 单条就很长 → 几十条必然超额度（不必依赖具体数字：额度由 shared 层管）
    const long = "很长的内容".repeat(4000);
    const many = Array.from({ length: 6 }, (_, i) => step(i % 2 ? "assistant" : "user", `${long}第${i}条`, `L${i}`));
    const got = buildHistory(many);
    expect(got.truncated).toBe(true);
    expect(got.messages.length).toBeLessThan(many.length);
    // 留的是**最新**的：最后一条一定在，最早那条一定不在
    expect(got.messages[got.messages.length - 1]?.content).toContain(`第${many.length - 1}条`);
    expect(got.messages[0]?.content).not.toContain("第0条");
  });

  it("⭐ 保留额度可注入（审计 P156：别让同一条回合用两把尺）", () => {
    const many = Array.from({ length: 40 }, (_, i) => step(i % 2 ? "assistant" : "user", "字".repeat(500), `K${i}`));
    const wide = buildHistory(many);
    const narrow = buildHistory(many, { keepTokens: 3000 });
    expect(wide.truncated).toBe(false);
    expect(narrow.truncated, "小额度必须真的切（参数被无视了？）").toBe(true);
    expect(narrow.messages.length).toBeLessThan(wide.messages.length);
  });

  it("⭐ 保留段尽量以 user 开头（否则模型以为自己没头没脑说了那句）", () => {
    // 每条约 6000 token：额度两万 → 能留三条，四条留不下
    const mid = "很长的内容".repeat(1200);
    const many = [
      step("user", `${mid}A`),
      step("assistant", `${mid}B`),
      step("user", `${mid}C`),
      step("assistant", `${mid}D`),
    ];
    const got = buildHistory(many);
    expect(got.truncated).toBe(true);
    expect(got.messages[0]?.role).toBe("user");
    expect(got.messages.map((m) => m.content.slice(-1))).toEqual(["C", "D"]);
  });

  it("⭐⭐ 窗口**永不清空**：只有一条超长助手回复时也发得出去（发空历史更坏）", () => {
    /*
     * 这条是把 `recent.length > 0` 写出来的第一版踩出来的：
     * 那时"一条助手消息就吃满额度"会被挪进 older，于是这一轮**什么历史都不发**——
     * 模型以为这是全新对话。而用户的下一句紧跟在它后面，因果本来是顺的。
     */
    const huge = "很长的内容".repeat(4000);
    const got = buildHistory([step("assistant", huge)]);
    expect(got.messages).toHaveLength(1);
    expect(got.messages[0]?.content).toContain("很长的内容");
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
    /*
     * ⚠️ C3 改过措辞：不再写"你只能看到最近 20 条消息"。
     * 那个数字是硬截断留下的，而切分现在按**额度**走 —— 条数不是判据，
     * 写一个条数反而会让模型误判（同样 20 条，短消息与长消息差几十倍）。
     */
    expect(note).toContain("更早的对话已省略");
    expect(note).toContain("不要猜");
    expect(note).not.toContain("条消息");
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

describe("工具输出进历史的上限（补完③：400 → 8000）", () => {
  const trace = (output: unknown): ToolTrace => ({
    toolCallId: "c1",
    name: "memory_list",
    ok: true,
    line: "⚙ 记忆：已列出 20 条",
    output,
  });

  it("⭐ 400 字那条线松开了：一段千把字的工具输出**完整**进历史（原来会砍掉大半）", () => {
    // 造一段 1200 字的输出（原来 400 字就截）
    const items = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 条记忆内容`).join("；");
    expect(items.length).toBeGreaterThan(400);
    const got = withToolLines("好", [trace({ entries: items })]);
    expect(got).toContain(`第 40 条记忆内容`); // 最后一条也在（没被砍）
    expect(got).not.toContain("已截断");
  });

  it("⚠️ 安全阀仍在：单条超过 8000 字时截断并**写明**（不假装完整）", () => {
    const huge = "字".repeat(9000);
    const got = withToolLines("好", [trace({ body: huge })]);
    expect(got).toContain("已截断");
  });

  it("上限是常量、写在文件头（改它要改这里，逼一次「想清楚」）", () => {
    expect(TOOL_OUTPUT_LIMIT).toBe(8000);
  });
});
