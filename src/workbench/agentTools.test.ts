import { describe, expect, it } from "vitest";
import {
  AGENT_TOOLS,
  MEMORY_LIST_INPUT,
  MEMORY_LIST_TOOL,
  MEMORY_SAVE_INPUT,
  CANVAS_ADD_NODE_INPUT,
  CANVAS_ADD_NODE_TOOL,
  CANVAS_NODE_KINDS,
  MAX_SUBAGENT_DEPTH,
  SPAWN_AGENT_INPUT,
  SPAWN_AGENT_TOOL,
  subagentPrompt,
  MEMORY_SAVE_TOOL,
  REPEAT_VALUES,
  SCHEDULE_CREATE_INPUT,
  SCHEDULE_CREATE_TOOL,
  SCHEDULE_LIST_TOOL,
  blockedToTraces,
  describeToolResult,
  toolArgsSummary,
  rejectedLine,
  toolLabel,
  toolLine,
  toolSpec,
  unknownToolNotice,
} from "@shared/agentTools";
import { MEMORY_TEXT_LIMIT } from "@shared/memory";

/**
 * 工具协议（§141）。
 *
 * 这一组测的是**声明层**：参数校验、回注文案、界面文案。
 * 执行层在主进程（那里才有 store），由验收脚本真跑一次模型调用来验。
 */
describe("工具声明", () => {
  it("名字唯一、说明非空、都带 schema", () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of AGENT_TOOLS) {
      expect(t.description.length, t.name).toBeGreaterThan(10);
      expect(t.schema, t.name).toBeTruthy();
    }
  });

  it("按名字能取到；取不到就是 undefined（→ 走未知工具那条路）", () => {
    expect(toolSpec(MEMORY_SAVE_TOOL)?.name).toBe(MEMORY_SAVE_TOOL);
    expect(toolSpec(MEMORY_LIST_TOOL)?.name).toBe(MEMORY_LIST_TOOL);
    expect(toolSpec("no_such_tool")).toBeUndefined();
  });
});

describe("memory_save 的参数校验", () => {
  it("接受正常内容，并**去掉首尾空白**", () => {
    const got = MEMORY_SAVE_INPUT.parse({ text: "  我的店铺叫青山茶叶  " });
    expect(got.text).toBe("我的店铺叫青山茶叶");
  });

  it("空内容挡掉（否则会往长期记忆里塞一条空条目）", () => {
    expect(MEMORY_SAVE_INPUT.safeParse({ text: "" }).success).toBe(false);
    expect(MEMORY_SAVE_INPUT.safeParse({ text: "   " }).success).toBe(false);
  });

  it("超长挡掉（记忆会注入每次对话的系统提示词，必须限量）", () => {
    expect(MEMORY_SAVE_INPUT.safeParse({ text: "字".repeat(MEMORY_TEXT_LIMIT) }).success).toBe(true);
    expect(MEMORY_SAVE_INPUT.safeParse({ text: "字".repeat(MEMORY_TEXT_LIMIT + 1) }).success).toBe(false);
  });

  it("类型不对挡掉", () => {
    expect(MEMORY_SAVE_INPUT.safeParse({ text: 123 }).success).toBe(false);
    expect(MEMORY_SAVE_INPUT.safeParse({}).success).toBe(false);
  });

  it("memory_list 不需要参数", () => {
    expect(MEMORY_LIST_INPUT.safeParse({}).success).toBe(true);
  });
});

describe("未知工具的回注（goose / Factor 9 口径）", () => {
  it("告诉模型工具名不对，并**列出可用工具** —— 它才能自己纠正", () => {
    const msg = unknownToolNotice("remember_this");
    expect(msg).toContain("remember_this");
    expect(msg).toContain(MEMORY_SAVE_TOOL);
    expect(msg).toContain(MEMORY_LIST_TOOL);
    expect(msg).toMatch(/重试|改用/);
  });

  it("参数不合格时能带上原因", () => {
    const msg = unknownToolNotice(MEMORY_SAVE_TOOL, "text 太长");
    expect(msg).toContain(MEMORY_SAVE_TOOL);
    expect(msg).toContain("text 太长");
  });
});

describe("schedule_create 的参数校验（§145）", () => {
  it("正常输入通过，并去掉首尾空白", () => {
    const got = SCHEDULE_CREATE_INPUT.parse({
      title: "  每日行业新闻  ",
      prompt: "  汇总今天的行业新闻  ",
      repeat: "daily",
    });
    expect(got.title).toBe("每日行业新闻");
    expect(got.prompt).toBe("汇总今天的行业新闻");
  });

  it("⭐ 重复方式只认那五个值（模型编一个别的出来就挡在这儿）", () => {
    for (const ok of REPEAT_VALUES) {
      expect(SCHEDULE_CREATE_INPUT.safeParse({ title: "t", prompt: "p", repeat: ok }).success, ok).toBe(true);
    }
    for (const bad of ["everyday", "每天", "", "DAILY"]) {
      expect(SCHEDULE_CREATE_INPUT.safeParse({ title: "t", prompt: "p", repeat: bad }).success, bad).toBe(false);
    }
  });

  it("空标题 / 空 prompt 挡掉（做不出「没有内容的定时任务」）", () => {
    expect(SCHEDULE_CREATE_INPUT.safeParse({ title: "", prompt: "p", repeat: "daily" }).success).toBe(false);
    expect(SCHEDULE_CREATE_INPUT.safeParse({ title: "t", prompt: "  ", repeat: "daily" }).success).toBe(false);
  });

  it("custom 的间隔必须在 5 分钟 ~ 30 天之间", () => {
    const base = { title: "t", prompt: "p", repeat: "custom" as const };
    expect(SCHEDULE_CREATE_INPUT.safeParse({ ...base, customMinutes: 5 }).success).toBe(true);
    expect(SCHEDULE_CREATE_INPUT.safeParse({ ...base, customMinutes: 4 }).success).toBe(false);
    expect(SCHEDULE_CREATE_INPUT.safeParse({ ...base, customMinutes: 60 * 24 * 31 }).success).toBe(false);
  });

  it("定时任务在界面上归到「定时任务」这个标签下", () => {
    expect(toolLabel(SCHEDULE_CREATE_TOOL)).toBe("定时任务");
    expect(toolLabel(SCHEDULE_LIST_TOOL)).toBe("定时任务");
  });

  it("创建成功的留痕带上标题与下次时间（用户要能一眼看出建了什么）", () => {
    const line = describeToolResult(SCHEDULE_CREATE_TOOL, true, {
      count: 2,
      title: "每日行业新闻",
      next: "明天 09:00",
    });
    expect(line).toContain("每日行业新闻");
    expect(line).toContain("明天 09:00");
  });

  it("列出的留痕报条数", () => {
    expect(describeToolResult(SCHEDULE_LIST_TOOL, true, { count: 3, jobs: [] })).toBe("⚙ 定时任务：当前 3 条");
  });
});

describe("canvas_add_node 的参数校验（§146）", () => {
  it("只认已核实字段名的两种节点类型（其余类型放出去只会写错字段）", () => {
    expect(CANVAS_NODE_KINDS).toEqual(["markdown", "code"]);
    for (const kind of CANVAS_NODE_KINDS) {
      expect(CANVAS_ADD_NODE_INPUT.safeParse({ kind, text: "内容" }).success, kind).toBe(true);
    }
    for (const bad of ["image", "whiteboard", "mermaid", "frame", "text"]) {
      expect(CANVAS_ADD_NODE_INPUT.safeParse({ kind: bad, text: "x" }).success, bad).toBe(false);
    }
  });

  it("空内容挡掉（做不出一个空节点）", () => {
    expect(CANVAS_ADD_NODE_INPUT.safeParse({ kind: "markdown", text: "" }).success).toBe(false);
    expect(CANVAS_ADD_NODE_INPUT.safeParse({ kind: "markdown" }).success).toBe(false);
  });

  it("lang 可选，给 code 用", () => {
    expect(CANVAS_ADD_NODE_INPUT.safeParse({ kind: "code", text: "print(1)", lang: "python" }).success).toBe(true);
    expect(CANVAS_ADD_NODE_INPUT.safeParse({ kind: "code", text: "print(1)" }).success).toBe(true);
  });

  it("界面上归到「画布」这个标签下", () => {
    expect(toolLabel(CANVAS_ADD_NODE_TOOL)).toBe("画布");
  });

  it("留痕说清放了哪种节点、以及是不是顺带把画布打开了", () => {
    expect(describeToolResult(CANVAS_ADD_NODE_TOOL, true, { kind: "markdown", opened: true })).toBe(
      "⚙ 画布：已在画布上放了一个文本节点（并打开了画布）",
    );
    expect(describeToolResult(CANVAS_ADD_NODE_TOOL, true, { kind: "code" })).toBe("⚙ 画布：已在画布上放了一个代码节点");
  });
});

describe("子智能体（§150）", () => {
  it("工具表里有它", () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toContain(SPAWN_AGENT_TOOL);
    expect(toolLabel(SPAWN_AGENT_TOOL)).toBe("子智能体");
  });

  it("⭐ 最多一层：MAX_SUBAGENT_DEPTH = 1（再往下派只会让「归谁做」变模糊、成本指数涨）", () => {
    expect(MAX_SUBAGENT_DEPTH).toBe(1);
  });

  it("task 必填、有上限；context 可选", () => {
    expect(SPAWN_AGENT_INPUT.safeParse({ task: "算 12×13" }).success).toBe(true);
    expect(SPAWN_AGENT_INPUT.safeParse({ task: "算 12×13", context: "只要结果" }).success).toBe(true);
    expect(SPAWN_AGENT_INPUT.safeParse({ task: "" }).success).toBe(false);
    expect(SPAWN_AGENT_INPUT.safeParse({ task: "字".repeat(501) }).success).toBe(false);
  });

  it("⭐ 提示词要求「只回要点」（否则它那几轮全灌回父级 = 白折腾一层）", () => {
    const { system } = subagentPrompt("算 12×13");
    expect(system).toContain("只给**要点**");
    expect(system).toContain("把过程一步步复述一遍");
  });

  it("⭐ 提示词要求「工具说要确认的如实写进回报」——不能假装做完了", () => {
    const { system } = subagentPrompt("存到记忆里");
    expect(system).toContain("如实写进回报");
    expect(system).toContain("别假装做完了");
  });

  it("给了 background 就一并交代，没给就只有任务", () => {
    expect(subagentPrompt("算 12×13").user).toBe("任务：算 12×13");
    expect(subagentPrompt("算 12×13", "背景 X").user).toContain("交代的背景");
  });

  it("留痕写清步数与**上卷的 token**（成本上卷要看得见）", () => {
    expect(describeToolResult(SPAWN_AGENT_TOOL, true, { ok: true, steps: 3, usage: { inputTokens: 800, outputTokens: 400 } })).toBe(
      "⚙ 子智能体：完成（3 步，约 1.2k tokens）",
    );
    expect(describeToolResult(SPAWN_AGENT_TOOL, true, { ok: true, steps: 1, usage: { inputTokens: 120, outputTokens: 30 } })).toBe(
      "⚙ 子智能体：完成（1 步，约 150 tokens）",
    );
  });

  it("⭐ 有「没执行、等你确认」的动作要写在留痕里（审批穿透的证据）", () => {
    const line = describeToolResult(SPAWN_AGENT_TOOL, true, {
      ok: true,
      steps: 2,
      blocked: ["⚙ 记忆：等你确认（还没执行）"],
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    expect(line).toContain("1 项等你确认");
  });

  it("失败时不留「完成」字样", () => {
    expect(describeToolResult(SPAWN_AGENT_TOOL, false, undefined, "拿不到 provider")).toBe("⚙ 子智能体失败：拿不到 provider");
  });
});

describe("结果与界面文案", () => {
  it("两个记忆工具在界面上都叫「记忆」", () => {
    expect(toolLabel(MEMORY_SAVE_TOOL)).toBe("记忆");
    expect(toolLabel(MEMORY_LIST_TOOL)).toBe("记忆");
    expect(toolLabel("other_tool")).toBe("other_tool");
  });

  it("保存成功 → 报出条数（用户要能看出「真的写进去了」）", () => {
    expect(describeToolResult(MEMORY_SAVE_TOOL, true, { ok: true, count: 3 })).toBe("⚙ 记忆：已保存，当前 3 条");
  });

  it("重复内容 → 如实说「已经记过了」，不假装又存了一条", () => {
    const line = describeToolResult(MEMORY_SAVE_TOOL, true, { ok: true, count: 3, note: "这条已经记过了，没有重复添加" });
    expect(line).toContain("已经记过");
    expect(line).not.toContain("已保存");
  });

  it("记忆满了 → 如实说没存进去", () => {
    const line = describeToolResult(MEMORY_SAVE_TOOL, true, { ok: true, count: 100, note: "记忆已满（上限 100 条），这条没有存进去" });
    expect(line).toContain("没有存进去");
  });

  it("失败 → 带原因，且与成功的样子明显不同", () => {
    const bad = describeToolResult(MEMORY_SAVE_TOOL, false, undefined, "写盘失败");
    expect(bad).toContain("失败");
    expect(bad).toContain("写盘失败");
    expect(bad).not.toContain("已完成");
  });

  it("列出记忆 → 报条数", () => {
    expect(describeToolResult(MEMORY_LIST_TOOL, true, { count: 2, entries: ["a", "b"] })).toBe("⚙ 记忆：当前 2 条");
  });

  it("未知工具也有兜底文案（不能渲染出 undefined）", () => {
    expect(toolLine("weird_tool", true)).toBe("⚙ weird_tool：已完成");
    expect(toolLine("weird_tool", false, "炸了")).toBe("⚙ weird_tool失败：炸了");
  });

  /*
   * 用户拒绝（§144）。
   *
   * 拒绝**也要留痕**：那条 trace 得改成"你已拒绝"，而不是把 pending 抹掉就算 ——
   * 抹掉的话用户回头再看这条回复，会以为"当时就执行了"。
   */
  it("拒绝的留痕与「已完成」「等你确认」都长得不一样", () => {
    const rejected = rejectedLine("memory_save");
    expect(rejected).toBe("⚙ 记忆：你已拒绝");
    expect(rejected).not.toContain("已保存");
    expect(rejected).not.toContain("等你确认");
  });

  it("拒绝的文案也走同一张标签表（不会露出内部工具名）", () => {
    expect(rejectedLine("memory_list")).toBe("⚙ 记忆：你已拒绝");
    expect(rejectedLine("unknown_tool")).toBe("⚙ unknown_tool：你已拒绝");
  });
});


describe("工具参数进留痕（§175）", () => {
  it("⭐ 记忆保存要说清**存了什么** —— 否则「已保存」等于没说", () => {
    expect(toolArgsSummary(MEMORY_SAVE_TOOL, { text: "我叫阿岩" })).toBe("写入「我叫阿岩」");
  });

  it("定时任务说标题", () => {
    expect(toolArgsSummary(SCHEDULE_CREATE_TOOL, { title: "每日站会提醒" })).toBe("「每日站会提醒」");
  });

  it("画布节点说类型与标题", () => {
    expect(toolArgsSummary(CANVAS_ADD_NODE_TOOL, { kind: "code", title: "冒泡排序" })).toBe("代码节点「冒泡排序」");
    expect(toolArgsSummary(CANVAS_ADD_NODE_TOOL, { kind: "markdown" })).toBe("文本节点");
  });

  it("子智能体说任务", () => {
    expect(toolArgsSummary(SPAWN_AGENT_TOOL, { task: "查一下上传链路" })).toBe("任务：查一下上传链路");
  });

  it("太长的参数截断（留痕是一行，不是一段）", () => {
    const got = toolArgsSummary(MEMORY_SAVE_TOOL, { text: "阿".repeat(100) });
    expect(got.length).toBeLessThan(60);
    expect(got.endsWith("…」")).toBe(true);
  });

  it("⭐ 说不出来就**什么都不说**（不硬编一句「已执行」糊过去）", () => {
    expect(toolArgsSummary(MEMORY_LIST_TOOL, {})).toBe("");
    expect(toolArgsSummary("unknown_tool", { a: 1 })).toBe("");
    expect(toolArgsSummary(MEMORY_SAVE_TOOL, {})).toBe("");
    expect(toolArgsSummary(MEMORY_SAVE_TOOL, undefined)).toBe("");
  });

  it("参数形状不可信时也不炸（数字/数组/null）", () => {
    expect(toolArgsSummary(MEMORY_SAVE_TOOL, 42)).toBe("");
    expect(toolArgsSummary(SCHEDULE_CREATE_TOOL, [1, 2])).toBe("");
    expect(toolArgsSummary(SPAWN_AGENT_TOOL, null)).toBe("");
  });

  it("换行会被压成空格（留痕是一行）", () => {
    expect(toolArgsSummary(MEMORY_SAVE_TOOL, { text: "第一行\n第二行" })).toBe("写入「第一行 第二行」");
  });

  describe("并进 describeToolResult", () => {
    it("⭐ 给了参数 → 结果后面补一句「传了什么」", () => {
      const line = describeToolResult(MEMORY_SAVE_TOOL, true, { count: 3 }, undefined, { text: "我叫阿岩" });
      expect(line).toBe("⚙ 记忆：已保存，当前 3 条（写入「我叫阿岩」）");
    });

    it("⭐ 不给参数 → **一个字符都不变**（老断言全部照旧）", () => {
      const a = describeToolResult(MEMORY_SAVE_TOOL, true, { count: 3 });
      const b = describeToolResult(MEMORY_SAVE_TOOL, true, { count: 3 }, undefined, undefined);
      expect(a).toBe("⚙ 记忆：已保存，当前 3 条");
      expect(b).toBe(a);
    });

    it("⭐ 被闸门拦下那一条也带参数 —— 用户正要决定「放不放行」，更该看见它要做什么", () => {
      const line = describeToolResult(MEMORY_SAVE_TOOL, true, { pending: true }, undefined, { text: "我叫阿岩" });
      expect(line).toContain("等你确认");
      expect(line).toContain("我叫阿岩");
    });

    it("失败那条也带参数（排错时要看它传了什么）", () => {
      const line = describeToolResult(SCHEDULE_CREATE_TOOL, false, undefined, "写盘失败", { title: "站会" });
      expect(line).toContain("写盘失败");
      expect(line).toContain("站会");
    });
  });
});


describe("子智能体被拦下的调用上交父级（§176）", () => {
  it("⭐ 上交的必须**结构化**（工具名 + 参数都在）—— 只给一行字的话，父级根本没辙执行它", () => {
    const traces = blockedToTraces([
      { toolCallId: "call-1", name: "memory_save", input: { text: "我叫阿岩" } },
    ]);
    expect(traces).toHaveLength(1);
    expect(traces[0]?.name).toBe("memory_save");
    expect(traces[0]?.input).toEqual({ text: "我叫阿岩" });
    expect(traces[0]?.toolCallId).toBe("call-1");
  });

  it("⭐ 每一条都是 pending —— 界面据此给出「允许 / 拒绝」按钮", () => {
    const traces = blockedToTraces([{ toolCallId: "c", name: "memory_save" }]);
    expect(traces[0]?.pending).toBe(true);
  });

  it("那一行要**说得出来历**（不是本轮的调用，是子智能体想做的）", () => {
    const line = blockedToTraces([{ toolCallId: "c", name: "memory_save" }])[0]?.line ?? "";
    expect(line).toContain("子智能体");
    expect(line).toContain("等你确认");
    expect(line).toContain("记忆");
  });

  it("单次调用的 id 原样带过来（放行时要按 id 找到它）", () => {
    const traces = blockedToTraces([
      { toolCallId: "a", name: "memory_save" },
      { toolCallId: "b", name: "schedule_create" },
    ]);
    expect(traces.map((x) => x.toolCallId)).toEqual(["a", "b"]);
  });

  it("没有上交的调用就给空数组（不凭空造一条）", () => {
    expect(blockedToTraces([])).toEqual([]);
    expect(blockedToTraces(undefined)).toEqual([]);
  });

  it("参数缺失时 Trace 里就不带 input（不塞一个 undefined 进去）", () => {
    const trace = blockedToTraces([{ toolCallId: "c", name: "memory_save" }])[0]!;
    expect("input" in trace).toBe(false);
  });

  it("子智能体报告里那几个的数量照旧被说出来（`N 项等你确认`）", () => {
    const line = describeToolResult(
      SPAWN_AGENT_TOOL,
      true,
      { ok: true, steps: 2, blocked: [{ toolCallId: "a", name: "memory_save" }] },
    );
    expect(line).toContain("1 项等你确认");
  });
});
