import { describe, expect, it } from "vitest";

import { formatDuration, layersOf, progressOf, resumeCommand, timelineOf } from "./workflowView";
import type { WorkflowStepView } from "@shared/ipc";

/**
 * 工作流泳道（V6-2l 的界面数据层）。
 *
 * 分层只由依赖决定 —— 界面不自己猜"大概在第二阶段"。
 * 成环/坏依赖不许死循环：认不出的落到最后一层，让人看见。
 */

const step = (id: string, dependsOn: string[] = [], status: WorkflowStepView["status"] = "pending"): WorkflowStepView => ({
  id,
  agent: "agent",
  task: id,
  dependsOn,
  status,
});

describe("分层", () => {
  it("按依赖分层：无依赖第一层、依赖满足后进下一层", () => {
    const layers = layersOf([step("research"), step("design"), step("write", ["research", "design"]), step("review", ["write"])]);
    expect(layers.map((l) => l.steps.map((s) => s.id))).toEqual([["research", "design"], ["write"], ["review"]]);
  });

  it("缺依赖当作已满足（不把整条流水线卡死）；成环落到最后一层", () => {
    const layers = layersOf([step("a", ["missing"]), step("b", ["c"]), step("c", ["b"])]);
    expect(layers[0]!.steps.map((s) => s.id)).toEqual(["a"]);
    expect(layers.at(-1)!.steps.map((s) => s.id).sort()).toEqual(["b", "c"]);
  });

  it("进度只数 done（跳过/失败不算完成）", () => {
    expect(progressOf([step("a", [], "done"), step("b", [], "failed"), step("c", [], "skipped"), step("d", [], "pending")])).toEqual({
      done: 1,
      total: 4,
    });
  });

  it("续跑命令指向 runs/<id>.json", () => {
    expect(resumeCommand("wf-1", "C:/data/workflows")).toContain("runs/wf-1.json");
  });
});

/** G10：时间线（泳道回答依赖，时间线回答"时间花在哪"）。 */
describe("时间线", () => {
  const step = (over: Record<string, unknown>) => ({
    id: "s1",
    agent: "a",
    task: "t",
    dependsOn: [],
    status: "done" as const,
    ...over,
  });

  it("没有开始时间 → 不画（不是画成 0 宽）", () => {
    expect(timelineOf({ steps: [step({})] })).toBeNull();
    expect(timelineOf({ steps: [] })).toBeNull();
  });

  it("按真实起止算左右位置，正在跑的那一步右端用 now", () => {
    const t = timelineOf(
      {
        createdAt: 1000,
        steps: [
          step({ id: "a", startedAt: 1000, finishedAt: 2000 }),
          step({ id: "b", startedAt: 2000, status: "running" }),
        ],
      },
      3000,
    )!;
    expect(t.start).toBe(1000);
    expect(t.end).toBe(3000);
    expect(t.segments.map((s) => s.id)).toEqual(["a", "b"]);
    expect(t.segments[0]!.leftPct).toBe(0);
    expect(t.segments[0]!.widthPct).toBeCloseTo(50, 5);
    expect(t.segments[1]!.leftPct).toBeCloseTo(50, 5);
    expect(t.segments[1]!.live).toBe(true);
    expect(t.segments[1]!.durationMs).toBe(1000);
  });

  it("没跑过的步骤不进时间线（pending 不占时间）", () => {
    const t = timelineOf({ steps: [step({ id: "a", startedAt: 1, finishedAt: 2 }), step({ id: "b", status: "pending" })] })!;
    expect(t.segments.map((s) => s.id)).toEqual(["a"]);
  });

  it("极短的一步有最小可见宽度，且不越过 100%", () => {
    const t = timelineOf(
      { steps: [step({ id: "a", startedAt: 1, finishedAt: 1 }), step({ id: "b", startedAt: 1, finishedAt: 10_000 })] },
      10_000,
    )!;
    const a = t.segments[0]!;
    expect(a.widthPct).toBeGreaterThanOrEqual(0.6);
    for (const s of t.segments) {
      expect(s.leftPct).toBeGreaterThanOrEqual(0);
      expect(s.leftPct + s.widthPct).toBeLessThanOrEqual(100.0001);
    }
  });

  it("时长文案三档：ms / 秒 / 分", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(65_000)).toBe("1m5s");
  });
});
