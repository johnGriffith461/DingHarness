import { describe, expect, it } from "vitest";
import { planRetry } from "./chatRetry";
import type { ChatMessageRecord } from "./chatStore";

/**
 * 「重试」的判断逻辑（§187 界面体检 P1）。
 *
 * 这里钉的是**撤销范围**：撤多了会把用户之前的话一起删掉，撤少了会让他同一句话
 * 问两遍（模型还会以为他在追问）。两种情况都是"看起来能用"的错，所以要有断言。
 */
const msg = (id: string, role: "user" | "assistant", status: ChatMessageRecord["status"] = "done", content = id): ChatMessageRecord => ({
  id,
  role,
  content,
  status,
  createdAt: 0,
});

describe("planRetry", () => {
  it("撤掉失败回复和它对应的提问，重发同一段话", () => {
    const list = [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user"), msg("a2", "assistant", "error")];
    const plan = planRetry(list, "a2");
    expect(plan).not.toBeNull();
    expect(plan!.text).toBe("u2");
    /* 留下的只有第一轮 —— 第二轮整轮撤掉，等重发重新长出来 */
    expect(plan!.keep.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("重发的是**用户那句话的原文**，不是助手那条", () => {
    const list = [msg("u1", "user", "done", "帮我把这段代码改成 TypeScript"), msg("a1", "assistant", "error", "前半截正文")];
    expect(planRetry(list, "a1")!.text).toBe("帮我把这段代码改成 TypeScript");
  });

  it("失败发生在中间（后面还有对话）时，连着后面一起撤 —— 不能留个断口", () => {
    const list = [msg("u1", "user"), msg("a1", "assistant", "error"), msg("u2", "user"), msg("a2", "assistant")];
    const plan = planRetry(list, "a1");
    expect(plan!.keep).toEqual([]);
    expect(plan!.text).toBe("u1");
  });

  it("连续两条失败回复：点哪条就以哪条为准往前找提问", () => {
    const list = [msg("u1", "user"), msg("a1", "assistant", "error"), msg("a2", "assistant", "error")];
    /* a2 前面最近的用户消息还是 u1 —— 撤掉 a1、a2 重发 u1 */
    expect(planRetry(list, "a2")!.keep).toEqual([]);
    expect(planRetry(list, "a2")!.text).toBe("u1");
  });

  it("说不上是重试的（消息 id 不在列表里）→ null，调用方什么都不做", () => {
    expect(planRetry([msg("u1", "user"), msg("a1", "assistant", "error")], "不存在")).toBeNull();
  });

  it("找不到提问时：只把那条失败回复收干净，不重发空内容", () => {
    const list = [msg("a1", "assistant", "error")];
    const plan = planRetry(list, "a1");
    expect(plan).toEqual({ text: "", keep: [] });
  });
});
