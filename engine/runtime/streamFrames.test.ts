import { describe, expect, it } from "vitest";

import {
  beginAttempt,
  canResume,
  createFrameLog,
  appendFrame,
  framesAfter,
  resumeRefusal,
} from "./streamFrames";

/**
 * 可续传的事件流（G07）。
 *
 * 判据：
 * ① seq 单调、回放**不重不漏**；
 * ② 重试后**只回放当前 attempt**（旧段的半截正文不许拼进来）；
 * ③ 进度帧（transient）不回放（补发只会让客户端以为又跑了一遍）；
 * ④ 落后太多（帧已被丢）时**明确拒绝**，不给缺头的正文。
 */

const frame = (event: string, data: string, kind: "durable" | "transient" = "durable") =>
  ({ kind, event, data }) as const;

describe("追加与回放", () => {
  it("seq 从 1 开始、单调递增", () => {
    const log = createFrameLog<string>();
    expect(appendFrame(log, frame("event", "a")).seq).toBe(1);
    expect(appendFrame(log, frame("event", "b")).seq).toBe(2);
  });

  it("⭐ 回放 after_seq 之后、不重不漏", () => {
    const log = createFrameLog<string>();
    appendFrame(log, frame("event", "a"));
    appendFrame(log, frame("event", "b"));
    appendFrame(log, frame("event", "c"));
    expect(framesAfter(log, 0).map((f) => f.data)).toEqual(["a", "b", "c"]);
    expect(framesAfter(log, 2).map((f) => f.data)).toEqual(["c"]);
    expect(framesAfter(log, 3)).toEqual([]);
  });

  it("⭐ 重试后只回放当前 attempt（旧段作废）", () => {
    const log = createFrameLog<string>();
    appendFrame(log, frame("event", "旧回答的一半"));
    beginAttempt(log);
    appendFrame(log, frame("event", "新回答"));
    expect(framesAfter(log, 0).map((f) => f.data)).toEqual(["新回答"]);
  });

  it("⭐ 进度帧不回放（transient）", () => {
    const log = createFrameLog<string>();
    appendFrame(log, frame("event", "正文"));
    appendFrame(log, frame("event", "第 3 步", "transient"));
    expect(framesAfter(log, 0).map((f) => f.data)).toEqual(["正文"]);
  });

  it("after_seq 是坏值时按 0 处理（不抛）", () => {
    const log = createFrameLog<string>();
    appendFrame(log, frame("event", "a"));
    expect(framesAfter(log, Number.NaN)).toHaveLength(1);
    expect(framesAfter(log, -5)).toHaveLength(1);
  });
});

describe("保留窗口", () => {
  it("超过上限丢最旧的帧，并如实记 dropped", () => {
    const log = createFrameLog<string>();
    for (let i = 0; i < 5; i += 1) appendFrame(log, frame("event", `f${i}`), 3);
    expect(log.frames).toHaveLength(3);
    expect(log.dropped).toBe(2);
  });

  it("⭐ 落后太多接不上：明确拒绝，不给缺头的正文", () => {
    const log = createFrameLog<string>();
    for (let i = 0; i < 5; i += 1) appendFrame(log, frame("event", `f${i}`), 3);
    /* 客户端只收到第 1 帧，而最旧的一帧是第 3 帧 → 中间丢了 */
    expect(canResume(log, 1)).toBe(false);
    expect(resumeRefusal(log)).toContain("接不上");
  });

  it("没丢帧时总能接上", () => {
    const log = createFrameLog<string>();
    appendFrame(log, frame("event", "a"));
    expect(canResume(log, 0)).toBe(true);
    expect(canResume(log, 1)).toBe(true);
  });

  it("从头开始（after_seq=0）但已经丢过帧 → 也接不上", () => {
    const log = createFrameLog<string>();
    for (let i = 0; i < 5; i += 1) appendFrame(log, frame("event", `f${i}`), 2);
    expect(canResume(log, 0)).toBe(false);
  });
});
