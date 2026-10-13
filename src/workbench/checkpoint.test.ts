import { describe, expect, it } from "vitest";
import { REWIND_HINT, branchFrom, planRewind, resolveRewindTarget } from "./checkpoint";
import type { TaskStep, WorkTask } from "./task";

/**
 * 会话检查点（§151）：回退与分支。
 *
 * 这一层是纯函数，所以"回到哪一步、丢掉哪些、重答哪一句"这几件事可以被钉死 ——
 * 而它们正是最容易差一格的地方（保留自己还是丢掉自己）。
 */
const step = (id: string, role: "user" | "assistant", text: string): TaskStep => ({ id, role, text, at: 0 });

const STEPS: TaskStep[] = [
  step("s1", "user", "第一问"),
  step("s2", "assistant", "第一答"),
  step("s3", "user", "第二问"),
  step("s4", "assistant", "第二答"),
  step("s5", "user", "第三问"),
  step("s6", "assistant", "第三答"),
];

describe("planRewind", () => {
  it("⭐ 回到哪一步就**保留**哪一步（差一格就变成「把它也丢了」）", () => {
    const plan = planRewind(STEPS, "s4");
    expect(plan?.kept.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(plan?.dropped).toBe(2);
  });

  it("回到最后一步时没东西可丢", () => {
    const plan = planRewind(STEPS, "s6");
    expect(plan?.kept).toHaveLength(6);
    expect(plan?.dropped).toBe(0);
  });

  it("回到第一步（丢掉其它全部）", () => {
    const plan = planRewind(STEPS, "s1");
    expect(plan?.kept).toHaveLength(1);
    expect(plan?.dropped).toBe(5);
  });

  it("⭐ 停在用户话上才「重答」（助手话结尾时重答没有对象）", () => {
    expect(planRewind(STEPS, "s5")?.reask).toBe("第三问");
    expect(planRewind(STEPS, "s6")?.reask).toBeNull();
  });

  it("保留的那批是**原对象**（不是副本里改了内容的另一批）", () => {
    const plan = planRewind(STEPS, "s3");
    expect(plan?.kept[0]).toBe(STEPS[0]);
  });

  it("不存在的 id 返回 null（磁盘来的东西一律不可信）", () => {
    expect(planRewind(STEPS, "s99")).toBeNull();
    expect(planRewind([], "s1")).toBeNull();
  });

  it("空步骤列表也不炸", () => {
    expect(planRewind([], "x")).toBeNull();
  });
});

describe("resolveRewindTarget：按钮长在助手那条，但意图是「重来」", () => {
  it("⭐ 点在助手那一条上 → 回到它前面那句用户话（保留并重答）", () => {
    expect(resolveRewindTarget(STEPS, "s4")).toBe("s3");
    expect(resolveRewindTarget(STEPS, "s2")).toBe("s1");
  });

  it("点在某句用户话上 → 回到它自己", () => {
    expect(resolveRewindTarget(STEPS, "s3")).toBe("s3");
    expect(resolveRewindTarget(STEPS, "s1")).toBe("s1");
  });

  it("前面没有用户话时退回「止步于此」（不硬找一个不存在的重答对象）", () => {
    const odd: TaskStep[] = [step("x1", "assistant", "开场白"), step("x2", "assistant", "接着")];
    expect(resolveRewindTarget(odd, "x2")).toBe("x2");
  });

  it("找不到那一步返回 null", () => {
    expect(resolveRewindTarget(STEPS, "s99")).toBeNull();
  });
});

describe("branchFrom", () => {
  const task = (): WorkTask => ({
    id: "t1",
    title: "原对话",
    brief: "原对话",
    createdAt: 1,
    stage: "running",
    startedAt: 1,
    finishedAt: null,
    steps: STEPS.map((s) => ({ ...s })),
    questions: [],
    questionIndex: 0,
    activity: "正在思考",
    artifacts: [],
  });

  it("分叉出来的是「到那一步为止」的一段对话", () => {
    const branch = branchFrom(task(), "s4", "t2", (n) => `b${n}`, 999);
    expect(branch?.steps).toHaveLength(4);
    expect(branch?.steps.map((s) => s.text)).toEqual(["第一问", "第一答", "第二问", "第二答"]);
  });

  it("⭐ 步骤 id **全部换新**（两条分支不能互相改到对方那一步）", () => {
    const branch = branchFrom(task(), "s4", "t2", (n) => `b${n}`, 999);
    expect(branch?.steps.map((s) => s.id)).toEqual(["b1", "b2", "b3", "b4"]);
    // 原对话那批 id 一个都不许出现在分支里
    for (const id of ["s1", "s2", "s3", "s4"]) {
      expect(branch?.steps.some((s) => s.id === id)).toBe(false);
    }
  });

  it("标题标注是分支，并且不超长", () => {
    expect(branchFrom(task(), "s2", "t2", (n) => `b${n}`, 999)?.title).toBe("原对话（分支）");
    const long = { ...task(), title: "标题".repeat(40) };
    expect((branchFrom(long, "s2", "t2", (n) => `b${n}`, 999)?.title ?? "").length).toBeLessThanOrEqual(60);
  });

  it("⭐ 不带过去「运行中/等待中」的状态（分支是一段已经答过的对话）", () => {
    const branch = branchFrom(task(), "s4", "t2", (n) => `b${n}`, 999);
    expect(branch?.stage).toBe("done");
    expect(branch?.activity).toBe("");
    expect(branch?.questions).toEqual([]);
  });

  it("不为「同一份产物挂两处」而复制产物（产物属于原对话那一份）", () => {
    const withArtifact = {
      ...task(),
      // 产物只用到"有一条"这个事实，字段按 Artifact 的最小形状给
      artifacts: [
        {
          id: "a1",
          taskId: "t1",
          stepId: "s2",
          title: "报告",
          kind: "markdown" as const,
          createdAt: 1,
          status: "generated" as const,
        },
      ],
    };
    expect(branchFrom(withArtifact, "s4", "t2", (n) => `b${n}`, 999)?.artifacts).toEqual([]);
  });

  it("分叉点不存在返回 null", () => {
    expect(branchFrom(task(), "s99", "t2", (n) => `b${n}`, 999)).toBeNull();
  });
});

describe("动作说明", () => {
  it("⭐ 明说「不撤销已发生的动作」—— 回退改的是对话，不是世界", () => {
    expect(REWIND_HINT).toContain("不会撤销");
    expect(REWIND_HINT).toContain("记忆");
  });
});
