import { describe, expect, it } from "vitest";

import { applyEvent, emptyTurn, finishTurn } from "./events";

/**
 * D1：`wroteFiles` 从 done 事件投影到 TurnView。
 * 宿主的验证闭环只看这个真值 —— 投影丢了它，验证就永远不会触发。
 */

describe("wroteFiles 投影", () => {
  it("done 带 wroteFiles → 投影里是 true", () => {
    const state = applyEvent(emptyTurn(), { type: "done", wroteFiles: true });
    expect(finishTurn(state).wroteFiles).toBe(true);
  });

  it("没有写文件时字段不出现（不是 false）", () => {
    const state = applyEvent(emptyTurn(), { type: "done" });
    expect(finishTurn(state).wroteFiles).toBeUndefined();
  });

  it("旧日志（done 没有该字段）照常投影", () => {
    const state = applyEvent(applyEvent(emptyTurn(), { type: "text", text: "hi" }), { type: "done" });
    const view = finishTurn(state);
    expect(view.text).toBe("hi");
    expect(view.done).toBe(true);
  });
});
