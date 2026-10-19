import { describe, expect, it } from "vitest";

import {
  RETRIEVABLE_TOOLS,
  clearableTools,
  clearedMarker,
  microCompact,
  toolNamesOf,
} from "./microCompact";
import type { ChatMessage } from "../../shared/ipc";

/**
 * microCompact（T3）。
 *
 * 守的是**边界**而不是"能不能清"：
 * - 只清可重取的（读类）工具；编辑与命令的结果永不清；
 * - 最近 N 条与最后一条永远不动；
 * - 关掉开关时**一条都不改**（老行为零漂移）。
 */

/* 真实量级：一次 read_file 的输出通常几千字符 —— 这也是这个优化存在的理由 */
const BIG = "x".repeat(4000);
const tool = (text: string, tools: string[]) =>
  `${text}\n\n（本步工具：${tools.map((t) => `${t}（输出：${BIG}）`).join("；")}）`;

function convo(): ChatMessage[] {
  return [
    { role: "user", content: "看一下这个文件" },
    { role: "assistant", content: tool("我先读一下。", ["read_file"]) },
    { role: "user", content: "然后呢" },
    { role: "assistant", content: tool("我把改动手改了。", ["edit_file"]) },
    { role: "user", content: "跑个测试" },
    { role: "assistant", content: tool("测试过了。", ["run_command"]) },
    { role: "user", content: "再读一个文件" },
    { role: "assistant", content: tool("读完了。", ["search_files"]) },
    { role: "user", content: "最后一句" },
  ];
}

describe("工具识别", () => {
  it("从工具块里抠出工具名", () => {
    expect(toolNamesOf("read_file src/a.ts（输出：…）；search_files query（输出：…）")).toEqual([
      "read_file",
      "search_files",
    ]);
  });

  it("可重取的工具通过", () => {
    expect(clearableTools("read_file src/a.ts（输出：…）")).toEqual(["read_file"]);
    expect(clearableTools("grep foo（输出：…）")).toEqual(["grep"]);
  });

  it("编辑与命令**不通过**（清掉会让模型以为没做过）", () => {
    expect(clearableTools("edit_file src/a.ts（输出：ok）")).toBeNull();
    expect(clearableTools("run_command npm test（输出：pass）")).toBeNull();
  });

  it("块里混着一个不可重取的 → 整块保留（保守）", () => {
    expect(clearableTools("read_file a（输出：…）；write_file b（输出：ok）")).toBeNull();
  });

  it("可重取清单里没有编辑/执行类工具（结构上防住）", () => {
    for (const name of ["write_file", "edit_file", "run_command", "spawn_agent"]) {
      expect(RETRIEVABLE_TOOLS.includes(name), `${name} 不该在可重取清单里`).toBe(false);
    }
  });
});

describe("清理行为", () => {
  it("旧的读类结果被换成占位，助手正文保留", () => {
    const result = microCompact(convo(), { keepRecent: 2 });
    const first = result.messages[1]!;
    expect(first.content).toContain("我先读一下。");
    expect(first.content).toContain("read_file 的结果已清理");
    expect(first.content).not.toContain("输出：x");
    expect(result.cleared).toBe(1);
  });

  it("编辑结果不被清", () => {
    const result = microCompact(convo(), { keepRecent: 2 });
    expect(result.messages[3]!.content).toContain("输出：x");
  });

  it("命令结果不被清", () => {
    const result = microCompact(convo(), { keepRecent: 2 });
    expect(result.messages[5]!.content).toContain("输出：x");
  });

  it("最近 N 条不动（含最后一条用户消息）", () => {
    const result = microCompact(convo(), { keepRecent: 4 });
    /* 最后 4 条：索引 5..8 —— 其中 7 是 search_files，也不该被动 */
    expect(result.messages[7]!.content).toContain("输出：x");
    expect(result.messages[8]!.content).toBe("最后一句");
  });

  it("最后一条永远不动，哪怕它的 keepRecent 更小", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: tool("读一下。", ["read_file"]) },
    ];
    const result = microCompact(msgs, { keepRecent: 1 });
    expect(result.messages[1]!.content).toContain("输出：x");
  });

  it("没有工具块的消息一条都不改", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    const result = microCompact(msgs, { keepRecent: 1 });
    expect(result.messages).toEqual(msgs);
    expect(result.cleared).toBe(0);
  });

  it("开关关掉时完全不动（老行为零漂移）", () => {
    const msgs = convo();
    const result = microCompact(msgs, { enabled: false, keepRecent: 1 });
    expect(result.messages).toEqual(msgs);
    expect(result.cleared).toBe(0);
  });

  it("省下的字符数是正数（说明真的短了）", () => {
    const result = microCompact(convo(), { keepRecent: 2 });
    expect(result.savedChars).toBeGreaterThan(0);
  });

  it("占位文案说清了「可以重新取回」", () => {
    expect(clearedMarker(["read_file"])).toContain("重新取回");
  });
});

describe("长会话（120 轮）里的实际效果", () => {
  it("清掉大半旧工具结果，但最近几轮与语义都还在", () => {
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 120; i += 1) {
      msgs.push({ role: "user", content: `第 ${i} 问` });
      msgs.push({
        role: "assistant",
        content: tool(`第 ${i} 答`, ["read_file"]),
      });
    }
    const before = msgs.reduce((n, m) => n + m.content.length, 0);
    const result = microCompact(msgs, { keepRecent: 6 });
    const after = result.messages.reduce((n, m) => n + m.content.length, 0);

    expect(result.cleared).toBeGreaterThan(100);
    expect(after).toBeLessThan(before * 0.9);
    /* 语义还在：每条助手消息的正文（"第 N 答"）都没丢 */
    for (let i = 0; i < 120; i += 1) {
      expect(result.messages[i * 2 + 1]!.content).toContain(`第 ${i} 答`);
    }
  });
});

describe("keepRounds：最近 N 轮整轮不动", () => {
  /** 造一轮：user + assistant(带可清工具块) */
  function round(n: number): ChatMessage[] {
    return [
      { role: "user", content: `第 ${n} 问` },
      { role: "assistant", content: `第 ${n} 答\n\n（本步工具：read_file a${n}.ts（输出：${"x".repeat(200)}））` },
    ];
  }

  it("⭐ 最近两轮（按 user 消息计）里的一条都不清", () => {
    const messages = [1, 2, 3, 4, 5].flatMap(round);
    const got = microCompact(messages, { keepRecent: 2, keepRounds: 2 });

    /* 最后一轮、倒数第二轮的工具块必须原样保留 */
    expect(got.messages[9]?.content).toContain("输出：");
    expect(got.messages[7]?.content).toContain("输出：");
    /* 更早的会被清 */
    expect(got.messages[1]?.content).toContain("已清理");
  });

  it("keepRounds=1 只保最后一轮", () => {
    const messages = [1, 2, 3].flatMap(round);
    const got = microCompact(messages, { keepRecent: 1, keepRounds: 1 });
    expect(got.messages[5]?.content).toContain("输出：");
    expect(got.messages[3]?.content).toContain("已清理");
  });
});
