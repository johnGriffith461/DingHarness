import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SKIP_ANSWER_TEXT, describeAnswer } from "./agent";
import { answerQuestion, type WorkTask } from "./task";

/**
 * 守卫：**提问卡上的 × 必须真的有用**（2026-10-16，审计 P81）。
 *
 * 修前实测：那颗 × 调的是 `abort()` —— 而提问态下**没有任何在跑的流**
 * （`activeHandle` / `runningRequestId` 都是 null），于是那一下什么都不做：
 * 卡片一动不动，任务**永远停在「正在询问用户」**（用户以为关掉就跳过了）。
 *
 * 判据分两层：
 *   · **行为**：把"跳过"当成答复喂进 `answerQuestion`，任务必须离开 `awaiting`
 *     （这是"卡死"这件事在状态机上唯一有意义的判据）；
 *   · **源码**：× 不许再调 `abort()`，要走 `answer(...)` —— 这类 bug 的形状就是"接错了一根线"，
 *     光测状态机挡不住它（`abort` 在别的场景里是对的）。
 */

function awaitingTask(): WorkTask {
  return {
    id: "t1",
    brief: "做个表",
    title: "做个表",
    steps: [{ id: "s1", role: "assistant", text: "先问一句", at: 1 }],
    artifacts: [],
    stage: "awaiting",
    activity: "正在询问用户",
    startedAt: 1,
    finishedAt: null,
    questions: [
      { id: "q1", text: "要几列？", options: [{ label: "三列" }, { label: "五列" }] },
    ],
    questionIndex: 0,
  } as unknown as WorkTask;
}

describe("提问卡的 × = 跳过这一问（P81）", () => {
  it("⭐ 跳过之后任务必须离开「等待用户」——这就是修前卡死的那一格", () => {
    const skipped = answerQuestion(awaitingTask(), describeAnswer({ id: "q", text: "要几列？", options: [] }, undefined, SKIP_ANSWER_TEXT), "s2", 100);
    expect(skipped.stage, "跳过之后还停在 awaiting —— 任务就永远等着了").not.toBe("awaiting");
    expect(skipped.stage).toBe("running");
    const last = skipped.steps[skipped.steps.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.text, "留下的答复要写明是跳过（模型收到空答复只会再问一遍）").toContain("跳过");
    expect(last.text, "也要带上原来问的是什么（事后翻记录看得懂）").toContain("要几列？");
  });

  it("多题时跳过只推进一题，不一把跳到底", () => {
    const task = awaitingTask();
    const two = {
      ...task,
      questions: [...task.questions, { id: "q2", text: "颜色？", options: [{ label: "蓝" }] }],
    } as WorkTask;
    const skipped = answerQuestion(two, describeAnswer(two.questions[0]!, undefined, SKIP_ANSWER_TEXT), "s2", 100);
    expect(skipped.questionIndex, "跳过第一题之后应当停在第二题").toBe(1);
    expect(skipped.stage, "还有下一题时要继续等用户（不是直接跑）").toBe("awaiting");
  });

  it("源码守卫：× 不许再调 abort()，必须走 answer(...)", () => {
    const text = readFileSync(path.resolve(__dirname, "QuestionCard.tsx"), "utf8");
    const noComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    /* 只盯那颗跳过键那一段 */
    const at = noComments.indexOf('data-testid="wb-question-skip"');
    expect(at, "跳过键不见了（这颗 × 就是这条用例的对象）").toBeGreaterThan(-1);
    const segment = noComments.slice(at, at + 400);
    expect(segment, "跳过键又调 abort() 了 —— 提问态下没有流可中止，那一下就是空操作").not.toContain("abort()");
    expect(segment, "跳过要走 answer(...)，与点选项同一条路").toContain("answer(");
    expect(segment, "跳过要用那句写明来意的文本").toContain("SKIP_ANSWER_TEXT");
  });
});
