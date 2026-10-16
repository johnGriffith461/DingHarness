import { describe, expect, it } from "vitest";
import {
  AGENT_GROUP_LABEL,
  AGENT_LABELS,
  AGENT_TAGS,
  AGENT_TAG_GROUPS,
  agentSummary,
  agentSystemPrompt,
  agentTagLine,
  makeAgent,
  normalizeAgentFile,
  normalizeAgents,
  validateAgent,
} from "@shared/agent";

/**
 * AI 智能体的纯逻辑（§156）。
 *
 * ⚠️ **文件名是 `agentCreate.test.ts` 而不是 `agent.test.ts`**：
 * 后者属于 `src/workbench/agent.ts`（任务智能体的提示词构造器，两段式流程）——
 * 两个"agent"是不同的东西，而我在 §156 里**复用了那个名字、把原来的测试覆盖了**。
 * 事故与补救记在 HANDOFF §156。
 *
 * 文案与标签断言对着 `docs/evidence-bot.txt`（本体前端包里的原文）。  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 * 注意本体那些标签**繁简混用**（服务端下发的），这里**照抄不简化** ——
 * 逐字对齐比"看着整齐"重要。
 */
const base = {
  name: "英老师",
  description: "你是一位经验丰富的英语老师。",
  background: ["老师"],
  characteristic: ["温和"],
  hobby: ["书籍"],
  setting: ["在咖啡馆"],
};

describe("文案与标签与本体对齐（逐字取自 create_bot_* 证据）", () => {
  it("标题与字段名", () => {
    expect(AGENT_LABELS.title).toBe("创建 AI 智能体");
    expect(AGENT_LABELS.name).toBe("名称");
    expect(AGENT_LABELS.namePlaceholder).toBe("输入名称");
    expect(AGENT_LABELS.description).toBe("设定描述");
    expect(AGENT_LABELS.oneClickFill).toBe("一键完善");
    expect(AGENT_LABELS.start).toBe("开始聊天");
    expect(AGENT_LABELS.failed).toBe("创建 AI 智能体失败");
  });

  it("示例占位一字不差（它是本体的原话）", () => {
    expect(AGENT_LABELS.promptPlaceholder).toContain("你是一位经验丰富的英语老师");
    expect(AGENT_LABELS.promptPlaceholder).toContain("幽默和实际应用案例");
  });

  it("四组标签的标题", () => {
    expect(AGENT_TAG_GROUPS).toEqual(["background", "characteristic", "hobby", "setting"]);
    expect(AGENT_GROUP_LABEL.background).toBe("背景");
    expect(AGENT_GROUP_LABEL.characteristic).toBe("特征");
    expect(AGENT_GROUP_LABEL.hobby).toBe("兴趣嗜好");
    expect(AGENT_GROUP_LABEL.setting).toBe("场景设定");
  });

  it("每组可选项与本体的那一组一致", () => {
    expect(AGENT_TAGS.background).toEqual(["CEO", "医生", "老师", "图书馆员", "运动员", "超级巨星"]);
    expect(AGENT_TAGS.characteristic).toEqual(["温和", "强势", "冷酷", "乐观", "害羞", "善妒"]);
    expect(AGENT_TAGS.hobby).toEqual(["书籍", "舞蹈", "游戏", "电影", "绘画", "摄影", "体育"]);
    expect(AGENT_TAGS.setting).toEqual(["在家", "在咖啡馆", "在公园", "在办公室", "在夜店", "旅行"]);
  });
});

describe("validateAgent", () => {
  it("名称与描述都填了才通过", () => {
    expect(validateAgent({ name: "甲", description: "乙" })).toBeNull();
  });

  it("空名称 / 空描述各自说清缺什么", () => {
    expect(validateAgent({ name: "  ", description: "乙" })).toBe("请先填名称");
    expect(validateAgent({ name: "甲", description: "   " })).toBe("请先填设定描述");
  });

  it("过长也挡（免得把提示词撑爆）", () => {
    expect(validateAgent({ name: "长".repeat(21), description: "乙" })).toContain("名称太长");
    expect(validateAgent({ name: "甲", description: "长".repeat(801) })).toContain("设定描述太长");
  });
});

describe("agentTagLine", () => {
  it("把四组折成一句人话", () => {
    expect(agentTagLine(base)).toBe("背景：老师；特征：温和；兴趣嗜好：书籍；场景设定：在咖啡馆");
  });

  it("没选任何标签时给空串（不留下孤零零的分号）", () => {
    expect(agentTagLine({ background: [], characteristic: [], hobby: [], setting: [] })).toBe("");
  });

  it("只选了一组也只写那一组", () => {
    expect(agentTagLine({ background: [], characteristic: ["冷酷"], hobby: [], setting: [] })).toBe("特征：冷酷");
  });

  it("多选的用顿号连起来", () => {
    expect(agentTagLine({ background: ["医生", "老师"], characteristic: [], hobby: [], setting: [] })).toBe(
      "背景：医生、老师",
    );
  });
});

describe("agentSystemPrompt", () => {
  it("⭐ 名称、描述、标签**都要进提示词** —— 模型看不到我们的数组", () => {
    const p = agentSystemPrompt(base);
    expect(p).toContain("英老师");
    expect(p).toContain("你是一位经验丰富的英语老师。");
    expect(p).toContain("背景：老师");
  });

  it("要求保持人设，且不许提「这是设定」（不然它会当场破功）", () => {
    const p = agentSystemPrompt(base);
    expect(p).toContain("始终以这个身份说话");
    expect(p).toContain("不要跳出角色");
  });

  it("没有标签时不留一个空的人设段", () => {
    const p = agentSystemPrompt({
      name: "甲",
      description: "乙",
      background: [],
      characteristic: [],
      hobby: [],
      setting: [],
    });
    expect(p).not.toContain("人设要点");
  });
});

describe("makeAgent", () => {
  it("去掉首尾空白", () => {
    const a = makeAgent("a1", { ...base, name: "  英老师  ", description: "  描述  " }, 1);
    expect(a.name).toBe("英老师");
    expect(a.description).toBe("描述");
  });

  it("标签去重且去掉空项（多选控件很容易给出重复）", () => {
    const a = makeAgent("a1", { ...base, hobby: ["书籍", "书籍", "", "  "] }, 1);
    expect(a.hobby).toEqual(["书籍"]);
  });
});

describe("agentSummary / normalizeAgents", () => {
  it("列表里那一行带标签摘要", () => {
    expect(agentSummary(makeAgent("a1", base, 1))).toContain("英老师");
    expect(agentSummary(makeAgent("a1", base, 1))).toContain("特征：温和");
  });

  it("没有标签时只显示名称（不留个孤零零的点）", () => {
    const a = makeAgent("a1", { ...base, background: [], characteristic: [], hobby: [], setting: [] }, 1);
    expect(agentSummary(a)).toBe("英老师");
  });

  it("坏数据丢掉、好数据保住", () => {
    const got = normalizeAgents([
      { id: "a1", name: "甲" },
      null,
      { name: "没有 id" },
      { id: "a2", name: "  " },
      { id: "a3", name: "丙", background: "不是数组" },
    ]);
    expect(got.map((a) => a.id)).toEqual(["a1", "a3"]);
    expect(got.find((a) => a.id === "a3")?.background).toEqual([]);
  });

  it("按创建时间排（旧在前）", () => {
    const got = normalizeAgents([
      { id: "b", name: "后", createdAt: 9 },
      { id: "a", name: "先", createdAt: 1 },
    ]);
    expect(got.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("不是数组就给空", () => {
    expect(normalizeAgents("x")).toEqual([]);
  });
});

describe("normalizeAgentFile（⭐ 把「当前选中的」也收窄成合法值）", () => {
  it("选中的那个还在 → 保留", () => {
    const got = normalizeAgentFile({ agents: [{ id: "a1", name: "甲" }], selected: "a1" });
    expect(got.selected).toBe("a1");
  });

  it("⭐ 选中的那个已经不在了 → 当作没选（否则会一直以为自己在用一个不存在的智能体）", () => {
    const got = normalizeAgentFile({ agents: [{ id: "a1", name: "甲" }], selected: "zzz" });
    expect(got.selected).toBe("");
  });

  it("兼容旧形状（之前文件里直接就是一个数组）", () => {
    const got = normalizeAgentFile([{ id: "a1", name: "甲" }]);
    expect(got.agents.map((a) => a.id)).toEqual(["a1"]);
    expect(got.selected).toBe("");
  });

  it("坏文件给空，不炸", () => {
    expect(normalizeAgentFile(null)).toEqual({ agents: [], selected: "" });
    expect(normalizeAgentFile("不是对象").agents).toEqual([]);
  });

  it("selected 不是字符串时当没选", () => {
    expect(normalizeAgentFile({ agents: [], selected: 42 }).selected).toBe("");
  });
});
