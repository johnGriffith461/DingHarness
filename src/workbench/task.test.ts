import { describe, expect, it } from "vitest";
import { normalizeTask } from "./taskPersist";
import {
  STEP_NOTE_LIMIT,
  normalizeArtifacts,
  normalizeQuestions,
  normalizeStep,
  acceptQuestions,
  answerQuestion,
  autoTaskTitle,
  cleanTitle,
  continueTargetOf,
  currentQuestion,
  formatDuration,
  MAX_QUESTIONS,
  progressLabel,
  questionProgress,
  TASK_TITLE_LIMIT,
  toRecentRow,
  type WorkTask,
} from "./task";

/** 造一个最小任务，只覆盖要测的部分。 */
function makeTask(patch: Partial<WorkTask> = {}): WorkTask {
  return {
    id: "t1",
    title: "测试任务",
    brief: "",
    createdAt: 0,
    stage: "running",
    startedAt: 0,
    finishedAt: null,
    steps: [],
    questions: [],
    questionIndex: 0,
    activity: "",
    artifacts: [],
    ...patch,
  };
}

/** 测试用的固定时间点（别用 Date.now()：断言要可复现）。 */
const NOW = 1_700_000_000_000;

import { ARTIFACT_FORMATS } from "./artifact";

describe("autoTaskTitle —— 对标原版「产品周报撰写」", () => {
  it("实测原例：从长句归纳出短标题并补动词后缀", () => {
    // 原版把这句话命名为「产品周报撰写」
    expect(autoTaskTitle("帮我写一份简短的产品周报，包含本周进展与下周计划")).toBe("产品周报撰写");
  });

  it("开头的动作词与量词要剥掉（不只是客气词）", () => {
    expect(autoTaskTitle("写一份竞品分析报告")).toBe("竞品分析报告撰写");
    expect(autoTaskTitle("整理一下客户名单")).toBe("客户名单");
    expect(autoTaskTitle("生成一张销售统计表")).toBe("销售统计表整理");
  });

  it("连续的修饰语要反复剥（一层不够）", () => {
    expect(autoTaskTitle("做一份正式的项目总结")).toBe("项目总结撰写");
  });

  it("开头的产物格式词要剥掉（原版推荐卡就是这种写法）", () => {
    expect(autoTaskTitle("Word 写一份总结汇报")).toBe("总结汇报撰写");
    expect(autoTaskTitle("PPT 制作一份 TED 风格演讲")).toBe("TED 风格演讲制作");
    expect(autoTaskTitle("excel 整理一份销售表")).toBe("销售表整理");
  });

  it("冒号后面的补充说明不进标题", () => {
    expect(autoTaskTitle("Word 写一份总结汇报：本周主要做了三件事，上线搜索功能")).toBe("总结汇报撰写");
  });

  it("去掉开头的客气词", () => {
    expect(autoTaskTitle("帮我整理一下客户名单")).not.toMatch(/^帮我/);
    expect(autoTaskTitle("麻烦写一份月报")).not.toMatch(/^麻烦/);
  });

  it("只取首个分句（后面的补充说明不进标题）", () => {
    const t = autoTaskTitle("做一个竞品分析方案，要求包含价格、渠道、用户口碑三个维度");
    expect(t).not.toContain("渠道");
  });

  it("按产物类型给不同后缀", () => {
    expect(autoTaskTitle("做一份 PPT")).toContain("制作");
    expect(autoTaskTitle("整理一张统计表")).toMatch(/整理/);
    expect(autoTaskTitle("写个方案")).toContain("拟定");
  });

  it("已经带后缀就不重复叠加", () => {
    expect(autoTaskTitle("产品周报撰写")).toBe("产品周报撰写");
  });

  it("空输入退成兜底标题", () => {
    expect(autoTaskTitle("")).toBe("新工作任务");
    expect(autoTaskTitle("   ")).toBe("新工作任务");
    expect(autoTaskTitle("帮我")).toBe("新工作任务");
  });

  it("超长标题被截断", () => {
    /*
     * ⚠️ 2026-10-16（审计 G53.c）：原来只断 `length <= 18` —— 返回空串、或只留一个字，
     * 这条都过。现在钉**逐字结果**（口径：先剥掉动作词与修饰语，再截到 14 个字）。
     */
    const t = autoTaskTitle("这是一句特别特别特别特别特别长的没有任何分句的描述");
    /* 口径：先剥动作词/修饰语，再截到 MAX=14 个字（这里没有产物词，所以不再加后缀） */
    expect(t).toBe("这是一句特别特别特别特别特别");
    expect(t.length).toBeLessThanOrEqual(18);
  });

  it("纯英文也能出标题", () => {
    expect(autoTaskTitle("write a weekly report").length).toBeGreaterThan(0);
  });
});

describe("formatDuration —— 四档（上位 i18n 的口径）", () => {
  it("不足 1 分只报秒", () => {
    expect(formatDuration(31_000)).toBe("31 秒");
    expect(formatDuration(0)).toBe("0 秒");
    expect(formatDuration(59_400)).toBe("59 秒");
  });

  it("超过 1 分报「N 分 M 秒」", () => {
    expect(formatDuration(155_000)).toBe("2 分 35 秒"); // 实测「已处理 2 分 35 秒」
    expect(formatDuration(221_000)).toBe("3 分 41 秒"); // 实测「共用时 3 分 41 秒」
  });

  it("整分钟也要带上 0 秒", () => {
    expect(formatDuration(120_000)).toBe("2 分 0 秒");
  });

  it("**满 1 小时要进位到「小时」档**（只做分/秒会显示成「120 分」）", () => {
    expect(formatDuration(3_600_000)).toBe("1 小时 0 分 0 秒");
    expect(formatDuration(3_723_000)).toBe("1 小时 2 分 3 秒");
    expect(formatDuration(7_200_000)).toBe("2 小时 0 分 0 秒");
  });

  it("**满 1 天要进位到「天」档**", () => {
    expect(formatDuration(86_400_000)).toBe("1 天 0 小时 0 分 0 秒");
    expect(formatDuration(90_061_000)).toBe("1 天 1 小时 1 分 1 秒");
  });

  it("只显示最高位那一档（有天就不提秒以外的小档已经算了，但格式是完整的）", () => {
    // 关键：有小时时不再出现「N 分 0 秒」这种第二档格式
    expect(formatDuration(3_600_000)).not.toMatch(/^\d+ 分/);
    expect(formatDuration(86_400_000)).not.toMatch(/^\d+ 小时/);
  });

  it("负数与 NaN 不产出怪文案", () => {
    expect(formatDuration(-5)).toBe("0 秒");
    expect(formatDuration(Number.NaN)).toBe("0 秒");
  });
});

describe("progressLabel", () => {
  it("运行中显示「已处理」", () => {
    const t = makeTask({ startedAt: 1000 });
    expect(progressLabel(t, 32_000)).toBe("已处理 31 秒");
  });

  it("完成后切成「共用时」", () => {
    const t = makeTask({ startedAt: 0, finishedAt: 221_000 });
    expect(progressLabel(t, 999_000)).toBe("共用时 3 分 41 秒");
  });

  it("等待用户回答时不显示进度（原版此时没有这一行）", () => {
    const t = makeTask({ startedAt: 0, stage: "awaiting" });
    expect(progressLabel(t, 60_000)).toBe("");
  });

  it("还没开始就空着", () => {
    expect(progressLabel(makeTask({ startedAt: null }), 1000)).toBe("");
  });
});

describe("提问卡推进", () => {
  const q = (id: string) => ({ id, text: `问题 ${id}`, options: [{ label: "A", hint: "a" }] });

  it("最多 3 题", () => {
    const list = acceptQuestions([q("1"), q("2"), q("3"), q("4")]);
    expect(list).toHaveLength(MAX_QUESTIONS);
    expect(list.map((x) => x.id)).toEqual(["1", "2", "3"]);
  });

  it("只有 awaiting 才给出当前问题", () => {
    const t = makeTask({ stage: "awaiting", questions: [q("1")] });
    expect(currentQuestion(t)?.id).toBe("1");
    expect(currentQuestion({ ...t, stage: "running" })).toBeNull();
  });

  it("分页文案是「当前/总数」", () => {
    const t = makeTask({ stage: "awaiting", questions: [q("1"), q("2"), q("3")], questionIndex: 0 });
    expect(questionProgress(t)).toBe("1/3");
    expect(questionProgress({ ...t, questionIndex: 1 })).toBe("2/3");
  });

  it("没有问题时分页为空", () => {
    expect(questionProgress(makeTask())).toBe("");
  });

  it("答完一题推进到下一题，仍处于 awaiting", () => {
    const t = makeTask({ stage: "awaiting", questions: [q("1"), q("2")], questionIndex: 0, startedAt: 0 });
    const next = answerQuestion(t, "选了 A", "s9", 5000);
    expect(next.questionIndex).toBe(1);
    expect(next.stage).toBe("awaiting");
    expect(next.steps.at(-1)).toMatchObject({ role: "user", text: "选了 A" });
  });

  it("答完最后一题切回 running，并**重新开始计时**（不该把用户思考时间算进「已处理」）", () => {
    const t = makeTask({ stage: "awaiting", questions: [q("1")], questionIndex: 0, startedAt: 0 });
    const next = answerQuestion(t, "选了 A", "s9", 999_000);
    expect(next.stage).toBe("running");
    expect(next.startedAt).toBe(999_000);
  });

  it("不在 awaiting 时回答不产生任何变化（防重复提交）", () => {
    const t = makeTask({ stage: "running", questions: [q("1")] });
    expect(answerQuestion(t, "x", "s1", 100)).toBe(t);
  });
});

describe("cleanTitle —— 清洗模型起的标题", () => {
  it("正常标题原样保留", () => {
    expect(cleanTitle("产品周报撰写")).toBe("产品周报撰写");
    expect(cleanTitle("总结汇报撰写")).toBe("总结汇报撰写");
  });

  it("去掉包裹的引号与书名号", () => {
    expect(cleanTitle("「产品周报撰写」")).toBe("产品周报撰写");
    expect(cleanTitle('"产品周报撰写"')).toBe("产品周报撰写");
    expect(cleanTitle("《产品周报》")).toBe("产品周报");
    expect(cleanTitle("【周报撰写】")).toBe("周报撰写");
  });

  it("去掉「标题：」前缀", () => {
    expect(cleanTitle("标题：产品周报撰写")).toBe("产品周报撰写");
    expect(cleanTitle("标题: 产品周报")).toBe("产品周报");
    expect(cleanTitle("title: Weekly report")).toBe("Weekly report");
  });

  it("去掉结尾标点", () => {
    expect(cleanTitle("产品周报撰写。")).toBe("产品周报撰写");
    expect(cleanTitle("产品周报撰写！")).toBe("产品周报撰写");
  });

  it("只取第一行（模型爱在后面加解释）", () => {
    expect(cleanTitle("产品周报撰写\n\n这个标题涵盖了你要的内容")).toBe("产品周报撰写");
  });

  it("超过 16 字截断（对齐上位口径）", () => {
    const long = "一二三四五六七八九十一二三四五六七八九十";
    expect(cleanTitle(long).length).toBe(16);
  });

  it("洗不出东西返回空串（调用方保留原标题）", () => {
    expect(cleanTitle("")).toBe("");
    expect(cleanTitle("   ")).toBe("");
    expect(cleanTitle("「」")).toBe("");
    expect(cleanTitle("。。。")).toBe("");
  });
});

describe("TASK_TITLE_LIMIT", () => {
  it("与上位口径一致（不超过 16 个字）", () => {
    expect(TASK_TITLE_LIMIT).toBe(16);
  });
});

describe("toRecentRow", () => {
  it("等待中带「待确认」", () => {
    expect(toRecentRow(makeTask({ stage: "awaiting", title: "产品周报撰写" }))).toMatchObject({
      title: "产品周报撰写",
      pending: true,
    });
  });

  it("完成的带上时长", () => {
    const row = toRecentRow(makeTask({ stage: "done", startedAt: 0, finishedAt: 221_000 }));
    expect(row.pending).toBe(false);
    expect(row.subtitle).toBe("3 分 41 秒");
  });

  it("跑着的没有时长", () => {
    expect(toRecentRow(makeTask({ stage: "running" })).subtitle).toBeUndefined();
  });
});


describe("恢复一步（§177）", () => {
  /** 落盘之后原样回来的一条（每个字段都给值）。 */
  const full = {
    id: "s9",
    role: "assistant",
    text: "这是当时的回复",
    at: 1_700_000_000_000,
    cost: 0.48,
    askedWith: "当时问的问题",
    rating: "up",
    tools: [{ toolCallId: "c1", name: "memory_save", ok: true, line: "⚙ 记忆：已保存", input: { text: "阿岩" } }],
    note: "更早的 7 条对话已压缩为摘要",
  };

  it("⭐ 每个字段都得活下来 —— 这一条是给「漏字段」这个毛病站岗的", () => {
    const got = normalizeStep(full, 9);
    expect(got.id).toBe("s9");
    expect(got.role).toBe("assistant");
    expect(got.text).toBe("这是当时的回复");
    expect(got.at).toBe(1_700_000_000_000);
    expect(got.cost).toBe(0.48);
    expect(got.askedWith).toBe("当时问的问题");
    expect(got.rating).toBe("up");
    expect(got.tools?.length).toBe(1);
    expect(got.tools?.[0]?.input).toEqual({ text: "阿岩" });
    expect(got.note).toBe("更早的 7 条对话已压缩为摘要");
  });

  it("⭐ 压缩摘要那条（`note`）必须活下来 —— §149 写它的理由就是「刷新不能没」", () => {
    expect(normalizeStep({ note: "更早的 3 条对话已压缩为摘要" }, 0).note).toBe("更早的 3 条对话已压缩为摘要");
  });

  it("缺 id 就按序号补一个（历史数据里可能真没有）", () => {
    /*
     * ⚠️ 2026-10-16（审计 G53.d）：期望值原来是 `makeStepId(4)` —— **被测模块自己的函数**，
     * 把它的形状改坏（比如一律返回 "s"）这条照样过。现在钉**字面量形状**，
     * 并顺带断"不同序号给不同 id、已有 id 不被覆盖"。
     */
    expect(normalizeStep({ text: "x" }, 4).id).toBe("s4");
    expect(normalizeStep({ text: "x" }, 5).id).toBe("s5");
    expect(normalizeStep({ id: "自己带的", text: "x" }, 6).id).toBe("自己带的");
  });

  it("role 只认 user，其余一律当 assistant（不出现第三种角色）", () => {
    expect(normalizeStep({ role: "user" }, 0).role).toBe("user");
    expect(normalizeStep({ role: "system" }, 0).role).toBe("assistant");
    expect(normalizeStep({}, 0).role).toBe("assistant");
  });

  it("评分只认 up/down（乱写的丢掉）", () => {
    expect(normalizeStep({ rating: "up" }, 0).rating).toBe("up");
    expect(normalizeStep({ rating: "什么" }, 0).rating).toBeUndefined();
  });

  it("⭐ 超长的 note 会被截断（留痕是一行，磁盘数据不可信）", () => {
    const got = normalizeStep({ note: "阿".repeat(500) }, 0).note ?? "";
    expect(got.length).toBe(STEP_NOTE_LIMIT);
  });

  it("空 note 就不带这个字段（不塞空串）", () => {
    expect("note" in normalizeStep({ note: "   " }, 0)).toBe(false);
    expect("note" in normalizeStep({}, 0)).toBe(false);
  });

  it("工具留痕为空时也不带字段", () => {
    expect("tools" in normalizeStep({ tools: [] }, 0)).toBe(false);
    expect("tools" in normalizeStep({ tools: "不是数组" }, 0)).toBe(false);
  });

  it("整条是垃圾也不炸（给一个最小可用的步骤）", () => {
    const got = normalizeStep(null, 0);
    expect(got.text).toBe("");
    expect(got.at).toBe(0);
    expect(got.role).toBe("assistant");
  });
});


describe("恢复产物（§179）", () => {
  const good = {
    id: "a1",
    taskId: "t1",
    stepId: "s1",
    title: "季度复盘",
    kind: "markdown",
    createdAt: NOW,
    status: "generated",
    content: "# 季度复盘",
    bytes: 12,
  };

  it("正常的一条原样活着（每个字段都在）", () => {
    const got = normalizeArtifacts([good])[0];
    expect(got?.id).toBe("a1");
    expect(got?.taskId).toBe("t1");
    expect(got?.stepId).toBe("s1");
    expect(got?.title).toBe("季度复盘");
    expect(got?.kind).toBe("markdown");
    expect(got?.status).toBe("generated");
    expect(got?.content).toBe("# 季度复盘");
    expect(got?.bytes).toBe(12);
  });

  it("⭐ kind 不认识的**丢掉** —— 认不出来的东西没法正确显示", () => {
    expect(normalizeArtifacts([{ ...good, kind: "word" }])).toEqual([]);
    expect(normalizeArtifacts([{ ...good, kind: undefined }])).toEqual([]);
  });

  it("缺 id 的丢掉", () => {
    expect(normalizeArtifacts([{ ...good, id: undefined }])).toEqual([]);
  });

  it("status 不认识就不带这个字段（不瞎猜一个中间态）", () => {
    expect(normalizeArtifacts([{ ...good, status: "什么" }])[0]?.status).toBeUndefined();
  });

  it("时间坏掉给 0（不是 NaN）", () => {
    expect(normalizeArtifacts([{ ...good, createdAt: "昨天" }])[0]?.createdAt).toBe(0);
    expect(normalizeArtifacts([{ ...good, createdAt: NaN }])[0]?.createdAt).toBe(0);
  });

  it("不是数组给空列表（坏文件不许把应用卡住）", () => {
    expect(normalizeArtifacts(null)).toEqual([]);
    expect(normalizeArtifacts("[]")).toEqual([]);
  });

  it("⭐ kind 的认识清单来自 `ARTIFACT_FORMATS`（加了新类型这里自动跟上，不另写一张表）", () => {
    for (const kind of Object.keys(ARTIFACT_FORMATS)) {
      expect(normalizeArtifacts([{ ...good, kind }])).toHaveLength(1);
    }
  });
});

describe("恢复澄清卡（§179）", () => {
  const good = {
    id: "q1",
    text: "这份复盘写给谁看？",
    options: [
      { label: "老板", hint: "结论优先" },
      { label: "同事", hint: "细节多一点" },
    ],
  };

  it("正常的一张原样活着", () => {
    const got = normalizeQuestions([good])[0];
    expect(got?.text).toBe("这份复盘写给谁看？");
    expect(got?.options).toHaveLength(2);
    expect(got?.options[0]?.label).toBe("老板");
  });

  it("⭐ **一个选项都没有的卡片丢掉** —— 界面上是 `question.options.map(...)`，一张没有选项的选择卡是死路", () => {
    expect(normalizeQuestions([{ id: "q", text: "x" }])).toEqual([]);
    expect(normalizeQuestions([{ id: "q", text: "x", options: [] }])).toEqual([]);
    expect(normalizeQuestions([{ id: "q", text: "x", options: "不是数组" }])).toEqual([]);
  });

  it("⭐ 这就是原来会**让整段对话打不开**的那种数据", () => {
    /*
     * ⚠️ 2026-10-16（审计 G53.b）：原来拿"全是非法输入"的数组归一化（结果是 `[]`）
     * 再对空数组 `every(...)` —— 空数组上 `every` **恒真**，这条什么都没验。
     * 现在混合输入：合法的那张必须留下（且 `options` 是数组），非法的那张必须被丢掉。
     */
    /*
     * ⚠️ 选项的形状是 `{ label, hint }`（不是字符串）—— 空 label 会被滤掉，
     * 一张选项全被滤空的卡片同样算"没有选项"、要丢掉。三种情形各验一遍。
     */
    const got = normalizeQuestions([
      { id: "bad", text: "没有选项" },
      { id: "bad2", text: "选项全是空 label", options: [{ label: "  " }] },
      { id: "ok", text: "有选项", options: [{ label: "甲" }, { label: "乙", hint: "乙的说明" }] },
    ]);
    expect(got.map((q) => q.id), "非法的那两种没被丢掉（界面会在它们上面炸）").toEqual(["ok"]);
    expect(got.every((q) => Array.isArray(q.options))).toBe(true);
    expect(got[0]?.options).toEqual([{ label: "甲", hint: "" }, { label: "乙", hint: "乙的说明" }]);
  });

  it("选项里没有文案的那几条丢掉（点不了的选项）", () => {
    const got = normalizeQuestions([{ ...good, options: [{ hint: "只有说明" }, { label: "有效" }] }])[0];
    expect(got?.options).toEqual([{ label: "有效", hint: "" }]);
  });

  it("hint 缺失给空串（不是 undefined）", () => {
    expect(normalizeQuestions([{ ...good, options: [{ label: "只有标题" }] }])[0]?.options[0]?.hint).toBe("");
  });

  it("超过 3 张截断（口径同创建时）", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...good, id: `q${i}` }));
    expect(normalizeQuestions(many)).toHaveLength(3);
  });

  it("缺 id 的丢掉", () => {
    expect(normalizeQuestions([{ ...good, id: undefined }])).toEqual([]);
  });

  it("不是数组给空列表", () => {
    expect(normalizeQuestions(null)).toEqual([]);
  });
});

describe("真实用量进步骤（C5）", () => {
  it("⭐ 合法的 usage 原样恢复（它是 provider 给的真值，丢了就只能显示估算）", () => {
    const step = normalizeStep({ id: "s1", role: "assistant", text: "答", at: 1, usage: { inputTokens: 2961, outputTokens: 44 } }, 0);
    expect(step.usage).toEqual({ inputTokens: 2961, outputTokens: 44 });
  });

  it("只有一半也留着（不假装缺的那半是 0）", () => {
    const step = normalizeStep({ id: "s1", role: "assistant", text: "答", at: 1, usage: { outputTokens: 44 } }, 0);
    expect(step.usage).toEqual({ outputTokens: 44 });
  });

  it("⭐⭐ 坏值一律丢掉 —— 编不出一个看起来像用量的数（那比没有更坏：界面会显示假的真值）", () => {
    for (const bad of [
      { inputTokens: "2961" },
      { inputTokens: -3 },
      { inputTokens: Number.NaN },
      { inputTokens: Number.POSITIVE_INFINITY },
      "2961",
      3,
      null,
      {},
    ]) {
      const step = normalizeStep({ id: "s1", role: "assistant", text: "答", at: 1, usage: bad }, 0);
      expect(step.usage, `应丢掉：${JSON.stringify(bad)}`).toBeUndefined();
    }
  });

  it("0 是合法值（真正的 0 与「没拿到」是两回事）", () => {
    const step = normalizeStep({ id: "s1", role: "assistant", text: "答", at: 1, usage: { inputTokens: 0 } }, 0);
    expect(step.usage).toEqual({ inputTokens: 0 });
  });
});

describe("流式草稿不落盘（2026-10-14）", () => {
  it("⭐ `draft` 是纯运行时字段：恢复出来的任务里**不许**带着它", () => {
    /*
     * 工作台流式时会把"正在长出来的正文"挂在 `task.draft` 上（在此之前只有一行「正在回复」，
     * 整段回答结束时才蹦出来）。但它**不该跨重启**：被中断的那一步本来就会被标成 failed，
     * 再留一份半截草稿只会自相矛盾 —— 而且它每几十毫秒变一次，落盘纯属浪费。
     * 落盘那侧会剥掉它（`taskPersist.ts`），这里钉的是**恢复那侧也不认它**。
     */
    const got = normalizeTask({
      id: "t1",
      title: "标题",
      brief: "做事",
      createdAt: 1,
      stage: "running",
      startedAt: 1,
      finishedAt: null,
      steps: [],
      questions: [],
      questionIndex: 0,
      activity: "正在回复",
      artifacts: [],
      draft: "半截正文不该活下来",
    });
    expect(got).not.toBeNull();
    expect((got as Record<string, unknown>).draft).toBeUndefined();
  });

  it("⭐ `material` 也是纯运行时字段：恢复出来的任务里不许带着它", () => {
    /*
     * 用户随这一轮交给 agent 的资料正文（「@ 添加资料」，最多 3×12000 字）。
     * 它只对**这一次请求**有意义：任务账本（`tasks.json`）不该被几万字的正文撑起来，
     * 重启后要重新添加。落盘前剥掉（`taskPersist.ts`），恢复那侧也不认它。
     */
    const got = normalizeTask({
      id: "t1",
      title: "标题",
      brief: "把这份资料整理成 PPT",
      createdAt: 1,
      stage: "running",
      startedAt: 1,
      finishedAt: null,
      steps: [],
      questions: [],
      questionIndex: 0,
      activity: "正在思考",
      artifacts: [],
      material: "【提到的文件】\n- D:\\a.md：\n季度总结正文",
    });
    expect(got).not.toBeNull();
    expect((got as Record<string, unknown>).material).toBeUndefined();
  });
});

describe("被中断的回合该继续什么（Phase 12.2 的桌面端入口）", () => {
  const task = (over: Partial<{ stage: string; activity: string; steps: Array<{ role: string; text: string }> }>) => ({
    stage: "failed",
    activity: "上次关闭时被中断",
    steps: [
      { role: "user", text: "把 demo 里的 md 整理成纪要" },
      { role: "assistant", text: "我看到两个文件，其中" },
    ],
    ...over,
  });

  it("被中断 + 有用户原话 → 给得出要继续的那句", () => {
    expect(continueTargetOf(task({}))).toBe("把 demo 里的 md 整理成纪要");
  });

  it("拿**最近**那句（多轮之后被打断时，继续的是最后那句）", () => {
    const multi = task({
      steps: [
        { role: "user", text: "第一句" },
        { role: "assistant", text: "回答一" },
        { role: "user", text: "第二句（这句被打断）" },
        { role: "assistant", text: "说到一半" },
      ],
    });
    expect(continueTargetOf(multi)).toBe("第二句（这句被打断）");
  });

  it("不是「被中断」的那种 failed（用户自己停的 / 报错的）→ 不给按钮", () => {
    expect(continueTargetOf(task({ activity: "已停止" }))).toBeNull();
    expect(continueTargetOf(task({ activity: "连不上 provider" }))).toBeNull();
    expect(continueTargetOf(task({ activity: "" }))).toBeNull();
  });

  it("跑得好好的任务不给按钮", () => {
    expect(continueTargetOf(task({ stage: "running" }))).toBeNull();
    expect(continueTargetOf(task({ stage: "done" }))).toBeNull();
  });

  it("找不到用户原话 → 不给按钮（按下去什么都不会发生的按钮比没有更糟）", () => {
    expect(continueTargetOf(task({ steps: [{ role: "assistant", text: "只有回答" }] }))).toBeNull();
    expect(continueTargetOf(task({ steps: [{ role: "user", text: "   " }] }))).toBeNull();
  });
});
