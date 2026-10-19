import { describe, expect, it } from "vitest";

import { applyEvent, emptyTurn, finishTurn } from "@engine/core/events";
import { compactPrompt, signatureOf, withSummary } from "./compaction";

/**
 * E2：压缩结构升级。
 * 判据：九段齐全、文件清单 ≤15、压缩事件可回放、旧日志（没有 compaction 事件）正常。
 */

describe("compactPrompt 的九段", () => {
  it("⭐ 九段都在（含 Verification）", () => {
    const { system } = compactPrompt([{ role: "user", content: "做一件事" }]);
    for (const section of [
      "Objective",
      "Requirements",
      "Decisions",
      "Work State",
      "Next Move",
      "Relevant Files",
      "Important Context",
      "Open Questions",
      "Verification",
    ]) {
      expect(system).toContain(section);
    }
  });

  it("文件清单上限写清（最多 15 个）", () => {
    expect(compactPrompt([]).system).toContain("最多 15 个");
  });

  it("空段写「无」，不是省略", () => {
    expect(compactPrompt([]).system).toContain("空段写「无」");
  });

  it("旧的八段摘要仍然可挂回系统提示词（兼容）", () => {
    const old = "1. Objective：x\n2. Requirements：y";
    expect(withSummary("SYS", old)).toContain(old);
  });
});

describe("签名缓存", () => {
  it("同一批消息签名稳定，改一个字就变", () => {
    const a = [{ role: "user" as const, content: "hello" }];
    const b = [{ role: "user" as const, content: "hello!" }];
    expect(signatureOf(a)).toBe(signatureOf(a));
    expect(signatureOf(a)).not.toBe(signatureOf(b));
  });
});

describe("compaction 事件", () => {
  it("⭐ 事件可 replay（投影里累计次数）", () => {
    let state = emptyTurn();
    state = applyEvent(state, { type: "compaction", fromSeq: 1, toSeq: 10, tokensBefore: 50_000, tokensAfter: 12_000 });
    state = applyEvent(state, { type: "compaction" });
    const view = finishTurn(state);
    expect(view.compactions).toBe(2);
  });

  it("旧日志没有 compaction 事件 → 字段不出现", () => {
    expect(finishTurn(emptyTurn()).compactions).toBeUndefined();
  });
});
