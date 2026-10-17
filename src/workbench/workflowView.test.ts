import { describe, expect, it } from "vitest";

import { layersOf, progressOf, resumeCommand } from "./workflowView";
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
