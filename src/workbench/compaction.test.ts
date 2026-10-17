import { describe, expect, it } from "vitest";
import {
  KEEP_TOKENS,
  SUMMARY_MARKER,
  compactPrompt,
  compactedNote,
  estimateTokens,
  shouldCompact,
  signatureOf,
  planContext,
  totalTokens,
  withSummary,
} from "./compaction";
import type { ChatMessage } from "@shared/ipc";

/**
 * 上下文压缩的纯逻辑（§149）。
 *
 * 参考 pi 的三条：`reserve` 给输出留额度、`keep` 保留最近一批、
 * 切割点不落 tool result。前两条在这里被钉住；**第三条在我们这里自动成立**
 * （工具留痕折进消息文本，按消息边界切就不可能切进工具结果里）—— 见 compaction.ts 的注释。
 */
const msg = (role: "user" | "assistant", content: string): ChatMessage => ({ role, content });

describe("estimateTokens", () => {
  it("中文按字算（一字约一个 token）", () => {
    expect(estimateTokens("你好世界")).toBe(4);
  });

  it("英文按 4 字符一个算", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  it("⭐ 同样字符数，中文估得明显更多 —— 这正是中英混排会爆的原因", () => {
    const zh = estimateTokens("一二三四五六七八");
    const en = estimateTokens("abcdefgh");
    expect(zh).toBe(8);
    expect(en).toBe(2);
    expect(zh).toBeGreaterThan(en * 3);
  });

  it("空串是 0（不能因为向上取整变成 1）", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("中英混排分别算再相加", () => {
    expect(estimateTokens("你好abcd")).toBe(2 + 1);
  });

  it("全角标点算中文（它一样占一个 token）", () => {
    expect(estimateTokens("，。？！")).toBe(4);
  });
});

describe("shouldCompact", () => {
  it("没超过额度就不压", () => {
    expect(shouldCompact([msg("user", "短")], KEEP_TOKENS)).toBe(false);
  });

  it("超过就压", () => {
    expect(shouldCompact([msg("user", "字".repeat(50))], 10)).toBe(true);
  });

  it("正好等于额度时不压（边界不该来回抖）", () => {
    const m = [msg("user", "字".repeat(10))];
    expect(totalTokens(m)).toBe(10);
    expect(shouldCompact(m, 10)).toBe(false);
  });
});

describe("planContext", () => {
  it("短历史全留在 recent，没有要压的", () => {
    const got = planContext([msg("user", "你好"), msg("assistant", "好")], 100);
    expect(got.recent).toHaveLength(2);
    expect(got.older).toHaveLength(0);
  });

  it("⭐ 切完两端拼起来不丢不重", () => {
    const all = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user", "字".repeat(10)));
    const { older, recent } = planContext(all, 30);
    expect(older.length + recent.length).toBe(all.length);
    expect([...older, ...recent]).toEqual(all);
  });

  it("⭐ recent 必须以 user 开头 —— 否则模型会以为自己刚说过那句", () => {
    // keep 刚好只装得下最后两条（assistant + user）时，必须再往前挪一条
    const all = [
      msg("user", "字".repeat(10)),
      msg("assistant", "字".repeat(10)),
      msg("assistant", "字".repeat(10)),
      msg("user", "字".repeat(10)),
    ];
    const { recent } = planContext(all, 25);
    expect(recent[0]?.role).toBe("user");
  });

  it("最后一条无论多大都留下（不能出现 recent 为空）", () => {
    const { recent } = planContext([msg("user", "字".repeat(500))], 10);
    expect(recent).toHaveLength(1);
    expect(estimateTokens(recent[0]?.content ?? "")).toBe(500);
  });

  it("空历史给两个空数组", () => {
    const got = planContext([], 10);
    expect(got.older).toEqual([]);
    expect(got.recent).toEqual([]);
  });

  it("留下来的那批是最新的（不是最旧的）", () => {
    const all = [msg("user", "最早"), msg("assistant", "中"), msg("user", "最新")];
    const { older, recent } = planContext(all, 2);
    expect(recent[recent.length - 1]?.content).toBe("最新");
    expect(older[0]?.content).toBe("最早");
  });
});

describe("compactPrompt", () => {
  it("把 older 拼成带角色的文本", () => {
    const { user } = compactPrompt([msg("user", "我要日报"), msg("assistant", "好")]);
    expect(user).toBe("用户：我要日报\n\n助手：好");
  });

  it("⭐ 结构化八段（G01）：目标/要求/决定/进度/下一步/文件/上下文/未决", () => {
    const { system } = compactPrompt([msg("user", "x")]);
    for (const section of ["Objective", "Requirements", "Decisions", "Work State", "Next Move", "Relevant Files", "Important Context", "Open Questions"]) {
      expect(system, `缺了 ${section} 这一段`).toContain(section);
    }
    expect(system).toContain("不要编造");
    /* 空段写「无」—— 否则读的人分不清"没有"与"漏了" */
    expect(system).toContain("无");
  });
});

describe("withSummary", () => {
  it("空摘要原样返回（不留一个空标题）", () => {
    expect(withSummary("系统", "   ")).toBe("系统");
  });

  it("⭐ 拼进去时标明「这不是用户说的话」", () => {
    const got = withSummary("系统", "用户要求每天 9 点看新闻");
    expect(got).toContain(SUMMARY_MARKER);
    expect(got).toContain("不是用户这次说的话");
    expect(got.endsWith("用户要求每天 9 点看新闻")).toBe(true);
  });
});

describe("摘要缓存用的签名（§149）", () => {
  it("同一批消息签名一致（这样才不会每次都重新压一遍）", () => {
    const a = [msg("user", "甲"), msg("assistant", "乙")];
    expect(signatureOf(a)).toBe(signatureOf([msg("user", "甲"), msg("assistant", "乙")]));
  });

  it("内容变了签名就变（否则会拿旧摘要糊弄新上下文）", () => {
    expect(signatureOf([msg("user", "甲")])).not.toBe(signatureOf([msg("user", "乙")]));
    expect(signatureOf([msg("user", "甲")])).not.toBe(signatureOf([msg("user", "甲"), msg("user", "甲")]));
  });

  it("签名里带条数，便于人肉对照", () => {
    expect(signatureOf([msg("user", "甲")]).startsWith("1:")).toBe(true);
  });
});

describe("界面上的那行提示", () => {
  it("说清压了几条", () => {
    expect(compactedNote(7)).toBe("更早的 7 条对话已压缩为摘要");
  });
});
