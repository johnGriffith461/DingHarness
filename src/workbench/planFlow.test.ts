import { describe, expect, it } from "vitest";

import { isPlanTransitionAllowed, planApprovalError, PLAN_TEXT_LIMIT } from "@engine/runtime/planMode";
import { normalizeTask } from "./taskPersist";

/**
 * G1 的桌面侧验收：状态机的**拒绝路径**与落盘恢复。
 *
 * 面板按钮的 disabled 只是提示；真正拦人的是 `planApprovalError`
 * （`store.approvePlan` 调它），所以这里直接钉它。
 */

const fullPlan = [
  "1. 目标：把失败测试修绿",
  "2. 范围：只改 engine/runtime",
  "3. 步骤：先复现再修",
  "4. 验证：pnpm test",
  "5. 风险：回滚这个 commit",
].join("\n");

describe("G1 批准判定", () => {
  it("⭐ idle → executing 被拒（不许跳过计划直接执行）", () => {
    expect(isPlanTransitionAllowed("idle", "executing")).toBe(false);
    expect(planApprovalError("idle", fullPlan)).toContain("还没有可批准的计划");
  });

  it("planning → executing 被拒（计划还没给出）", () => {
    expect(planApprovalError("planning", fullPlan)).toContain("还没有可批准的计划");
  });

  it("awaiting_approval + 五段齐全 → 通过", () => {
    expect(planApprovalError("awaiting_approval", fullPlan)).toBeNull();
  });

  it("缺段 / 空计划 → 给出可行动原因", () => {
    expect(planApprovalError("awaiting_approval", "")).toContain("空的");
    expect(planApprovalError("awaiting_approval", "1. 目标：x")).toContain("缺少");
  });

  it("执行中再批准 → 明确说已经在执行", () => {
    expect(planApprovalError("executing", fullPlan)).toContain("已经在执行");
  });
});

describe("G1 重启恢复", () => {
  const base = {
    id: "t-1",
    title: "计划任务",
    brief: "重构",
    createdAt: 1,
    stage: "done",
    startedAt: 1,
    finishedAt: 2,
    steps: [],
    questions: [],
    questionIndex: 0,
    activity: "",
    artifacts: [],
  };

  it("planState / planText / planPath / 写盘错误都随任务恢复", () => {
    const got = normalizeTask({
      ...base,
      planState: "executing",
      planText: fullPlan,
      planPath: "C:/p/.ding/plans/t-1.md",
      planWriteError: "磁盘满了",
    });
    expect(got?.planState).toBe("executing");
    expect(got?.planText).toBe(fullPlan);
    expect(got?.planPath).toContain(".ding/plans/t-1.md");
    expect(got?.planWriteError).toBe("磁盘满了");
  });

  it("旧盘没有计划字段 → 不编造（undefined）", () => {
    const got = normalizeTask(base);
    expect(got?.planState).toBeUndefined();
    expect(got?.planText).toBeUndefined();
  });

  it("非法状态被丢掉；超长计划被截断", () => {
    const got = normalizeTask({ ...base, planState: "executing; rm -rf /", planText: "x".repeat(PLAN_TEXT_LIMIT + 5) });
    expect(got?.planState).toBeUndefined();
    expect(got?.planText?.length).toBe(PLAN_TEXT_LIMIT);
  });
});
