import { describe, expect, it } from "vitest";

import {
  CARD_TTL_MS,
  cardText,
  createCardRegistry,
  feishuCard,
  makeCode,
  parseCardCommand,
  slackBlocks,
} from "./approvalCards";

/**
 * IM 审批卡（G12）。
 *
 * 判据：短码好打、`yes/no <码>` 只认这个形状、过期不生效、**first-come 只有一个生效**。
 */

const base = {
  sessionId: "s1",
  toolCallId: "c1",
  name: "write_file",
  summary: "「a.md」",
  chat: "oc_1",
  platform: "feishu",
};

function registry(nowRef: { t: number }, random: () => number = () => 0) {
  return createCardRegistry({ now: () => nowRef.t, random });
}

describe("短码", () => {
  it("4 位，避开容易看错的字符", () => {
    const code = makeCode(() => 0);
    expect(code).toHaveLength(4);
    expect(code).not.toMatch(/[01ilo]/);
  });
});

describe("解析回复", () => {
  it("⭐ 只认 `yes <码>` / `no <码>`（含中文同意/拒绝）", () => {
    expect(parseCardCommand("yes a3f2")).toEqual({ approved: true, code: "a3f2" });
    expect(parseCardCommand("NO A3F2")).toEqual({ approved: false, code: "a3f2" });
    expect(parseCardCommand("同意 a3f2")).toEqual({ approved: true, code: "a3f2" });
    expect(parseCardCommand("拒绝 a3f2")).toEqual({ approved: false, code: "a3f2" });
  });

  it("⭐ 自然语言里说「好的」不算（不能靠猜）", () => {
    expect(parseCardCommand("好的")).toBeNull();
    expect(parseCardCommand("yes")).toBeNull();
    expect(parseCardCommand("yes a3f2 快点")).toBeNull();
  });
});

describe("登记与决定", () => {
  it("同一条 toolCallId 重复登记返回同一个码（不重复发卡）", () => {
    const now = { t: 1000 };
    const reg = registry(now);
    const a = reg.add(base);
    const b = reg.add(base);
    expect(b.code).toBe(a.code);
    expect(reg.list()).toHaveLength(1);
  });

  it("⭐ first-come：第二次决定返回「已经被谁批过」", () => {
    const now = { t: 1000 };
    const reg = registry(now);
    const card = reg.add(base);
    const first = reg.resolve(card.code, true, "手机");
    expect(first.ok).toBe(true);
    const second = reg.resolve(card.code, false, "桌面");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("手机");
  });

  it("⭐ 过期不生效", () => {
    const now = { t: 1000 };
    const reg = registry(now);
    const card = reg.add(base);
    now.t += CARD_TTL_MS + 1;
    const got = reg.resolve(card.code, true, "手机");
    expect(got.ok).toBe(false);
  });

  it("sweep 清掉过期的并记账（超时 = 没批准）", () => {
    const now = { t: 1000 };
    const reg = registry(now);
    const card = reg.add(base);
    now.t += CARD_TTL_MS + 1;
    expect(reg.sweep()).toBe(1);
    const again = reg.resolve(card.code, true, "手机");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain("超时");
  });

  it("码不存在时给可读原因", () => {
    const reg = registry({ t: 1000 });
    const got = reg.resolve("zzzz", true, "手机");
    expect(got.ok).toBe(false);
  });
});

describe("卡片文案", () => {
  it("⭐ 带工具名、摘要、短码与剩余时间", () => {
    const now = { t: 1000 };
    const reg = registry(now);
    const card = reg.add(base);
    const text = cardText(card, { now: now.t });
    expect(text).toContain("write_file");
    expect(text).toContain("「a.md」");
    expect(text).toContain(`yes ${card.code}`);
    expect(text).toContain("秒内有效");
  });

  it("飞书与 Slack 的结构都带得上那段文字", () => {
    const now = { t: 1000 };
    const reg = registry(now);
    const card = reg.add(base);
    expect(JSON.stringify(feishuCard(card, { now: now.t }))).toContain("yes ");
    expect(JSON.stringify(slackBlocks(card, { now: now.t }))).toContain("yes ");
  });
});
