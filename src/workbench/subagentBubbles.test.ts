import { describe, expect, it } from "vitest";

import { SPAWN_AGENT_TOOL, SPAWN_AGENTS_TOOL, type ToolTrace } from "@shared/agentTools";
import { withSubagentApprovals } from "./subagentBubbles";

/**
 * **G11：子智能体审批冒泡**的判据。
 *
 * 之前 `subagentBlockedTraces()` 写了却没人调用 —— 用户只看到"它想做但没被批准"，
 * 没有任何地方能批。这里钉住"展开成父级待批行"这件事：
 * ① 两种报告形状都认（`spawn_agent` 的 report / `spawn_agents` 的汇总）；
 * ② 待批行带 name+input（否则允许之后执行不了）；
 * ③ 不重复、不误伤别的工具。
 */

const spawnTrace = (over: Partial<ToolTrace> = {}): ToolTrace => ({
  toolCallId: "parent-1",
  name: SPAWN_AGENT_TOOL,
  ok: true,
  line: "⚙ 子智能体：完成",
  output: {
    ok: true,
    summary: "子智能体报告",
    blocked: [
      { toolCallId: "sub-1", name: "write_file", input: { path: "a.txt", content: "x" } },
      { toolCallId: "sub-2", name: "run_command", input: { command: "ls" } },
    ],
  },
  ...over,
});

describe("withSubagentApprovals", () => {
  it("spawn_agent 的 blocked 展开成父级待批行（带参数）", () => {
    const out = withSubagentApprovals([spawnTrace()]);
    expect(out).toHaveLength(3);
    expect(out[0]!.toolCallId).toBe("parent-1");
    const pendingRows = out.slice(1);
    expect(pendingRows.map((t) => t.name)).toEqual(["write_file", "run_command"]);
    expect(pendingRows.every((t) => t.pending === true)).toBe(true);
    expect(pendingRows[0]!.input, "没有参数的话，允许之后执行不了").toEqual({ path: "a.txt", content: "x" });
    expect(pendingRows[0]!.line).toContain("子智能体想做但没被批准");
  });

  it("spawn_agents（小队）的汇总 blocked 也展开", () => {
    const trace: ToolTrace = {
      toolCallId: "team-1",
      name: SPAWN_AGENTS_TOOL,
      ok: true,
      line: "小队完成",
      output: {
        ok: true,
        summary: "汇总",
        members: [{ agent: "a", ok: true }],
        blocked: [{ toolCallId: "sub-9", name: "edit_file", input: { path: "b.ts" } }],
      },
    };
    const out = withSubagentApprovals([trace]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ toolCallId: "sub-9", name: "edit_file", pending: true });
  });

  it("没有 blocked / 不是派活工具 → 原样返回（一条不多）", () => {
    const plain: ToolTrace = { toolCallId: "t1", name: "read_file", ok: true, line: "读了", output: { text: "x" } };
    const noBlocked = spawnTrace({ output: { ok: true, summary: "没有拦下的" } });
    expect(withSubagentApprovals([plain])).toEqual([plain]);
    expect(withSubagentApprovals([noBlocked])).toHaveLength(1);
  });

  it("同 toolCallId 不重复展开（一轮里多次派活也不重）", () => {
    const out = withSubagentApprovals([spawnTrace(), spawnTrace({ toolCallId: "parent-2" })]);
    const ids = out.map((t) => t.toolCallId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("认 `{ report: {...} }` 这种包一层的输出（宿主差异）", () => {
    const wrapped = spawnTrace({ output: { report: { ok: true, summary: "x", blocked: [{ toolCallId: "sub-3", name: "write_file", input: {} }] } } });
    const out = withSubagentApprovals([wrapped]);
    expect(out).toHaveLength(2);
    expect(out[1]!.toolCallId).toBe("sub-3");
  });
});
