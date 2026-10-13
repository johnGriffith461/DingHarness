import { describe, expect, it } from "vitest";
import { normalizeTask } from "./taskPersist";

/**
 * 恢复一个任务的口径（§179）。
 *
 * ⚠️ 这个文件专门盯**状态**：哪些状态重启之后该活、哪些该被判死。
 * 起因：`awaiting`（等用户回答）原来被当成 `running` 一起标成失败 ——
 * 于是澄清卡永远不出现，用户再也回答不了那个问题。
 */
const NOW = 1_700_000_000_000;

const task = (patch: Record<string, unknown> = {}) => ({
  id: "t1",
  title: "标题",
  brief: "一句话",
  createdAt: NOW,
  stage: "done",
  startedAt: NOW,
  finishedAt: NOW + 1000,
  steps: [{ id: "s1", role: "user", text: "你好", at: NOW }],
  questions: [],
  questionIndex: 0,
  activity: "",
  artifacts: [],
  ...patch,
});

describe("恢复任务的状态口径（§179）", () => {
  it("⭐ `awaiting`（等用户回答）**必须活下来** —— 它等的是人，不是请求", () => {
    const got = normalizeTask(task({ stage: "awaiting" }));
    expect(got?.stage).toBe("awaiting");
  });

  it("⭐ `awaiting` 活下来之后，澄清卡才渲染得出来（界面只在 awaiting 时显示那张卡）", () => {
    const got = normalizeTask(
      task({
        stage: "awaiting",
        questions: [{ id: "q1", text: "写给谁看？", options: [{ label: "老板", hint: "" }] }],
      }),
    );
    expect(got?.stage).toBe("awaiting");
    expect(got?.questions).toHaveLength(1);
  });

  it("`running` 仍然被判成失败（上次关窗口时真在跑，恢复后没人接着跑）", () => {
    const got = normalizeTask(task({ stage: "running" }));
    expect(got?.stage).toBe("failed");
    expect(got?.activity).toBe("上次关闭时被中断");
  });

  it("`done` 不受影响", () => {
    expect(normalizeTask(task({ stage: "done" }))?.stage).toBe("done");
  });

  it("连 id 都没有 → null", () => {
    expect(normalizeTask(task({ id: undefined }))).toBeNull();
    expect(normalizeTask(null)).toBeNull();
  });
});
