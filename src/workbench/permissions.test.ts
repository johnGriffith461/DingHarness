import { describe, expect, it } from "vitest";
import {
  CONFIRM_MODES,
  TOOL_POLICY,
  decide,
  injectableTools,
  normalizeConfirmMode,
  pendingApprovalNotice,
  policyOf,
} from "@shared/permissions";
import { AGENT_TOOLS } from "@shared/agentTools";

/**
 * 审批闸门的判定矩阵（§143）。
 *
 * 这一组是整改「全部允许是个装饰」的核心证据：**三个档位 × 三类工具** 的每一种组合
 * 都必须有明确判定，而且"关掉"与"要确认"必须是**两种不同的结果**。
 */
describe("策略表", () => {
  it("三个档位的文案与实机一致（改一个都会让 chip 与本体对不上）", () => {
    expect(CONFIRM_MODES).toEqual(["全部允许", "按需确认", "每步确认"]);
  });

  it("⭐ 未声明的工具默认按**只读**放行（Cline 口径：需要复核的必须显式声明）", () => {
    expect(policyOf("some_new_tool")).toEqual({ kind: "read" });
    expect(decide("按需确认", "some_new_tool")).toBe("run");
  });

  it("⭐ 每个工具的性质都声明了（加工具时别漏 declare —— 漏了就悄悄变成「默认放行」）", () => {
    for (const t of AGENT_TOOLS) {
      expect(TOOL_POLICY[t.name], `${t.name} 没在 TOOL_POLICY 里声明`).toBeTruthy();
    }
    expect(policyOf("memory_save").kind).toBe("write");
    expect(policyOf("memory_list").kind).toBe("read");
    // 定时任务是"会反复自己跑"的东西，必须算写类（按需确认档要拦它）
    expect(policyOf("schedule_create").kind).toBe("write");
    expect(policyOf("schedule_list").kind).toBe("read");
  });
});

describe("decide：三档 × 三类工具", () => {
  it("全部允许 —— 读写都直接跑（这是今天的行为，不能改）", () => {
    expect(decide("全部允许", "memory_save")).toBe("run");
    expect(decide("全部允许", "memory_list")).toBe("run");
  });

  it("按需确认 —— 只拦**会改东西的**，只读的照走", () => {
    expect(decide("按需确认", "memory_save")).toBe("ask");
    expect(decide("按需确认", "memory_list")).toBe("run");
  });

  it("每步确认 —— 不管读写都要问", () => {
    expect(decide("每步确认", "memory_save")).toBe("ask");
    expect(decide("每步确认", "memory_list")).toBe("ask");
  });

  it("⭐ 关掉的工具**在任何档位**都是 hide —— 不是被拒，是模型看不到", () => {
    TOOL_POLICY.__test_disabled = { kind: "read", enabled: false };
    try {
      for (const mode of CONFIRM_MODES) {
        expect(decide(mode, "__test_disabled"), mode).toBe("hide");
      }
    } finally {
      delete TOOL_POLICY.__test_disabled;
    }
  });

  it("⭐ ask 与 hide 必须是两种结果（否则「关掉」会退化成「每次都问」）", () => {
    TOOL_POLICY.__gone = { kind: "write", enabled: false };
    try {
      // 同一个档位下：关掉的 → hide（模型看不到）；没关的写入类 → ask（要问）
      expect(decide("每步确认", "__gone")).toBe("hide");
      expect(decide("每步确认", "memory_save")).toBe("ask");
      expect(decide("每步确认", "__gone")).not.toBe(decide("每步确认", "memory_save"));
    } finally {
      delete TOOL_POLICY.__gone;
    }
  });
});

describe("injectableTools：hide 的不进注入列表", () => {
  it("默认（全部允许）下全部注入", () => {
    expect(injectableTools("全部允许", ["a", "b"])).toEqual(["a", "b"]);
  });

  it("⚠️ 被关掉的不在列表里 —— 模型看不到它（区别于「注入了但会被拒」）", () => {
    TOOL_POLICY.__gone = { kind: "write", enabled: false };
    try {
      expect(injectableTools("全部允许", ["memory_save", "__gone"])).toEqual(["memory_save"]);
      expect(injectableTools("每步确认", ["memory_save", "__gone"])).toEqual(["memory_save"]);
    } finally {
      delete TOOL_POLICY.__gone;
    }
  });

  it("保持原顺序", () => {
    expect(injectableTools("按需确认", ["b", "a", "c"])).toEqual(["b", "a", "c"]);
  });
});

describe("normalizeConfirmMode：磁盘上的东西不可信", () => {
  it("合法值原样通过", () => {
    for (const m of CONFIRM_MODES) expect(normalizeConfirmMode(m)).toBe(m);
  });

  it("乱七八糟的值一律回落到「全部允许」（与今天的行为一致，不会突然全都要确认）", () => {
    for (const bad of [undefined, null, "", "EveryStep", 3, {}, []]) {
      expect(normalizeConfirmMode(bad)).toBe("全部允许");
    }
  });
});

describe("被拦下时回给模型的话", () => {
  it("说清三件事：没执行 / 等谁 / 别再试", () => {
    const msg = pendingApprovalNotice("memory_save", "按需确认");
    expect(msg).toContain("memory_save");
    expect(msg).toContain("按需确认");
    expect(msg).toContain("还没有执行");
    expect(msg).toContain("不要重试");
  });
});
