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

/**
 * ICM 的两个字段（V6-1c）：压缩次数与上下文索引。
 *
 * 它们是"永不遗忘"的产品面支撑 —— 重启之后索引必须还在，
 * 否则下一次请求会拿不到接力棒，长任务的目标就断了。
 */
describe("恢复 ICM 字段（V6-1c）", () => {
  const index = {
    version: 1,
    sessionId: "task-42",
    goal: "整理纪要",
    decisions: ["只用本地文件"],
    openItems: ["第四节"],
    artifacts: ["纪要.md"],
    anchor: { seq: 120, eventCount: 340 },
    createdAt: NOW,
  };

  it("索引与压缩次数都活下来", () => {
    const got = normalizeTask(task({ contextCompactions: 2, contextIndex: index }));
    expect(got?.contextCompactions).toBe(2);
    expect(got?.contextIndex).toEqual(index);
  });

  it("不认识的索引版本 → 丢掉（不猜旧格式，拿错接力棒比没有更危险）", () => {
    const got = normalizeTask(task({ contextIndex: { ...index, version: 99 } }));
    expect(got?.contextIndex).toBeUndefined();
  });

  it("坏字段被收窄：数组里混入非字符串、锚点不是数字都清掉", () => {
    const got = normalizeTask(
      task({
        contextCompactions: Number.NaN,
        contextIndex: { ...index, decisions: ["好的", 42, null], anchor: { seq: "x", eventCount: 12 } },
      }),
    );
    expect(got?.contextCompactions).toBeUndefined();
    expect(got?.contextIndex?.decisions).toEqual(["好的"]);
    expect(got?.contextIndex?.anchor).toEqual({ seq: 0, eventCount: 12 });
  });

  it("老任务没有这两个字段 → 也不编一个出来", () => {
    const got = normalizeTask(task());
    expect(got?.contextCompactions).toBeUndefined();
    expect(got?.contextIndex).toBeUndefined();
  });
});
