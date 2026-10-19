import { describe, expect, it } from "vitest";

import { editedBranchFrom } from "./checkpoint";
import type { WorkTask } from "./task";

/**
 * C4：编辑用户消息并重发 = **fork 出前缀 + 新消息**，原对话不动。
 * 这里测的是那条纯构造（store 只负责把它落进状态并发请求）。
 */

function task(): WorkTask {
  return {
    id: "t1",
    title: "原对话",
    brief: "第一句",
    createdAt: 1,
    stage: "done",
    startedAt: 1,
    finishedAt: 2,
    steps: [
      { id: "s1", role: "user", text: "第一句", at: 1 },
      { id: "s2", role: "assistant", text: "第一次回答", at: 2 },
      { id: "s3", role: "user", text: "第二句", at: 3 },
      { id: "s4", role: "assistant", text: "第二次回答", at: 4 },
    ],
    questions: [],
    questionIndex: 0,
    activity: "",
    artifacts: [{ id: "a1", taskId: "t1", kind: "markdown", title: "旧产物", content: "x", createdAt: 1 }],
  };
}

describe("editedBranchFrom", () => {
  it("⭐ 新分支 = 目标之前的轮次 + 新用户消息；原对话一个字不动", () => {
    const original = task();
    const before = JSON.stringify(original);

    const branch = editedBranchFrom(original, "s3", "改过的第二句", "t2", 10);

    expect(branch).not.toBeNull();
    expect(branch!.id).toBe("t2");
    expect(branch!.steps.map((s) => s.text)).toEqual(["第一句", "第一次回答", "改过的第二句"]);
    expect(branch!.steps.at(-1)?.role).toBe("user");
    expect(JSON.stringify(original)).toBe(before);
  });

  it("目标之前的助手步骤也会保留（重发依赖这段上下文）", () => {
    const branch = editedBranchFrom(task(), "s3", "新内容", "t2", 10);
    expect(branch!.steps.some((s) => s.text === "第一次回答")).toBe(true);
    expect(branch!.steps.some((s) => s.text === "第二句")).toBe(false);
  });

  it("编辑第一条：前缀为空，只剩新的用户消息", () => {
    const branch = editedBranchFrom(task(), "s1", "全新的第一句", "t2", 10);
    expect(branch!.steps).toHaveLength(1);
    expect(branch!.steps[0]).toMatchObject({ role: "user", text: "全新的第一句" });
  });

  it("产物不带到分支上（同一份文件不该挂两处）", () => {
    expect(editedBranchFrom(task(), "s3", "x", "t2", 10)!.artifacts).toEqual([]);
  });

  it("助手消息 / 不存在的 step 返回 null", () => {
    expect(editedBranchFrom(task(), "s2", "x", "t2", 10)).toBeNull();
    expect(editedBranchFrom(task(), "nope", "x", "t2", 10)).toBeNull();
  });

  it("步骤 id 全部重发号，不会与原对话撞", () => {
    const branch = editedBranchFrom(task(), "s3", "x", "t2", 10)!;
    expect(branch.steps.every((s) => s.id.startsWith("t2-s"))).toBe(true);
  });
});
