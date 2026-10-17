import { describe, expect, it } from "vitest";

import {
  PRUNE_HEAD_CHARS,
  PRUNE_TAIL_CHARS,
  pruneMessages,
  pruneText,
} from "./pruner";

/**
 * 超长消息裁剪（G01）。
 *
 * 判据：短消息**原样**（同引用）；超长时头尾都在、中间说明裁了多少；
 * 最后一条 user 不许裁。
 */

const long = (n: number) => `HEAD${"x".repeat(n)}TAIL`;

describe("pruneText", () => {
  it("短文本原样返回（连对象都不换）", () => {
    const got = pruneText("hello");
    expect(got.pruned).toBe(false);
    expect(got.text).toBe("hello");
    expect(got.droppedChars).toBe(0);
  });

  it(`⭐ 超 ${"8000"} 字：保留头 ${PRUNE_HEAD_CHARS} / 尾 ${PRUNE_TAIL_CHARS}，中间写明裁了多少`, () => {
    const text = long(20_000);
    const got = pruneText(text);
    expect(got.pruned).toBe(true);
    expect(got.droppedChars).toBe(20_000 + 8 - PRUNE_HEAD_CHARS - PRUNE_TAIL_CHARS);
    expect(got.text.startsWith("HEAD")).toBe(true);
    expect(got.text.endsWith("TAIL")).toBe(true);
    expect(got.text).toContain("已裁掉");
    expect(got.text.length).toBeLessThan(text.length);
  });

  it("正好等于阈值不裁（边界）", () => {
    expect(pruneText("a".repeat(8_000)).pruned).toBe(false);
    expect(pruneText("a".repeat(8_001)).pruned).toBe(true);
  });
});

describe("pruneMessages", () => {
  it("⭐ 最后一条 user 永远不裁", () => {
    const messages = [
      { role: "assistant" as const, content: "a".repeat(20_000) },
      { role: "user" as const, content: "u".repeat(20_000) },
    ];
    const got = pruneMessages(messages);
    expect(got.pruned).toBe(1);
    expect(got.messages[0]?.content).toContain("已裁掉");
    expect(got.messages[1]).toBe(messages[1]);
  });

  it("都短时原样返回（数组是新的，元素引用不变）", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];
    const got = pruneMessages(messages);
    expect(got.pruned).toBe(0);
    expect(got.messages[0]).toBe(messages[0]);
    expect(got.messages[1]).toBe(messages[1]);
  });

  it("较早的 user 可以被裁（只有最后一条受保护）", () => {
    const messages = [
      { role: "user" as const, content: "old".repeat(10_000) },
      { role: "assistant" as const, content: "ok" },
      { role: "user" as const, content: "现在这句" },
    ];
    expect(pruneMessages(messages).pruned).toBe(1);
  });
});
