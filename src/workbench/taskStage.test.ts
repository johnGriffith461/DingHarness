import { describe, expect, it } from "vitest";

import { awaitingOfTraces, taskStageOfReply } from "./taskRuntime";
import type { ToolTrace } from "@shared/agentTools";

/**
 * T-02：待审批时任务停在 `awaiting`（不是 `done`）。
 *
 * 缺陷形状：闸门拦下之后模型继续生成并收尾，界面显示"已完成"，
 * 而那次写文件其实**还没执行**。WorkBuddy 记录到模型自己的原话：
 * 「那次收尾的文案和事实对不上」。
 */
describe("taskStageOfReply", () => {
  it("待审批 → awaiting", () => {
    expect(taskStageOfReply({ awaiting: true })).toBe("awaiting");
  });

  it("正常收尾 → done", () => {
    expect(taskStageOfReply({ awaiting: false })).toBe("done");
  });
});

describe("awaitingOfTraces", () => {
  const pending = (id: string, name = "write_file"): ToolTrace => ({
    toolCallId: id,
    name,
    ok: true,
    line: "⚙ 等你确认（还没执行）",
    pending: true,
  });

  it("有 pending 就给出最后一个（用户先处理最新的）", () => {
    const got = awaitingOfTraces([
      pending("c1"),
      { toolCallId: "c2", name: "read_file", ok: true, line: "已读" },
      pending("c3"),
    ]);
    expect(got.awaitingApproval).toEqual({ toolCallId: "c3", name: "write_file" });
  });

  it("没有 pending → 不产生字段（不造一个空对象）", () => {
    expect(awaitingOfTraces([{ toolCallId: "c1", name: "read_file", ok: true, line: "已读" }])).toEqual({});
  });
});
