import { describe, expect, it } from "vitest";
import {
  ASK_CLOSE,
  ASK_OPEN,
  buildAskPrompt,
  buildDoPrompt,
  buildFollowUpPrompt,
  describeAnswer,
  parseAskReply,
} from "./agent";
import type { TaskOption, TaskQuestion } from "./task";

/**
 * 任务智能体的两段式提示词与解析（`src/workbench/agent.ts`）。
 *
 * ⚠️ **这个文件是重建的（§156 的事故）**。原来的 `agent.test.ts` 被我写新测试时
 * 覆盖掉了（我复用了同一个文件名，却没先看它是否已存在）。
 * 仓库里没有 git 历史、快照插件也没有那一批的记录，所以原文无法找回。
 *
 * 这里按**当前实现**重建了一版覆盖：两段提示词的形状、提问块的解析、
 * 以及回答的成句。**它不是原来那一份**，作用是把"这个模块一行测试都没有"补上。
 */
const q = (patch: Partial<TaskQuestion> = {}): TaskQuestion => ({
  id: "q1",
  text: "要做给谁看？",
  options: [],
  ...patch,
});
const opt = (label: string, hint = ""): TaskOption => ({ label, hint });

describe("buildAskPrompt（第一段：先问清关键信息）", () => {
  it("把提问块的格式写进系统提示词（模型要照着产出）", () => {
    const { system } = buildAskPrompt("帮我做个周报");
    expect(system).toContain(ASK_OPEN);
    expect(system).toContain(ASK_CLOSE);
    expect(system).toContain("最多 3 个问题");
  });

  it("⭐ 明确要求「能直接干就直接干」，别没事找事地问", () => {
    const { system } = buildAskPrompt("1+1");
    expect(system).toContain("能不能直接把活干好");
    expect(system).toContain("就直接干活");
  });

  it("用户那句话原样进 user", () => {
    expect(buildAskPrompt("帮我做个周报").user).toContain("帮我做个周报");
  });

  it("没有背景时不拼背景块（不留一个空标题）", () => {
    expect(buildAskPrompt("x").user).not.toContain("已经问过并得到回答的背景");
  });

  it("有背景时编号列出来（第二段要靠它接着答）", () => {
    const { user } = buildAskPrompt("x", ["受众 → 老板", "篇幅 → 一页"]);
    expect(user).toContain("【已经问过并得到回答的背景】");
    expect(user).toContain("1. 受众 → 老板");
    expect(user).toContain("2. 篇幅 → 一页");
  });
});

describe("buildDoPrompt（第二段：拿着回答干活）", () => {
  it("⭐ 要求不要再反问、直接给成品", () => {
    const { system } = buildDoPrompt("做周报", ["受众 → 老板"]);
    expect(system).toContain("不要再反问");
    expect(system).toContain("直接给成品");
  });

  it("产物块的规则在（含类型枚举与五条规矩）", () => {
    const { system } = buildDoPrompt("做周报", []);
    expect(system).toContain("产物要怎么给");
    expect(system).toContain("docx");
    expect(system).toContain("canvas");
    expect(system).toContain("块里就是**成品的完整内容**");
  });

  it("user 里同时有任务与关键信息", () => {
    const { user } = buildDoPrompt("做周报", ["受众 → 老板", "篇幅 → 一页"]);
    expect(user).toContain("任务：做周报");
    expect(user).toContain("我提供的关键信息：");
    expect(user).toContain("1. 受众 → 老板");
  });

  it("一条关键信息都没有时也不崩（空块）", () => {
    expect(buildDoPrompt("做周报", []).user).toContain("我提供的关键信息：");
  });
});

describe("buildFollowUpPrompt（接着聊，§147）", () => {
  it("⭐ 不把任务复述一遍 —— 前因后果都在历史里", () => {
    const { user, system } = buildFollowUpPrompt("那再改一版");
    expect(user).toBe("那再改一版");
    expect(user).not.toContain("任务：");
    expect(system).toContain("同一段对话");
  });

  it("产物规则与第二段共用同一份（不各写一份）", () => {
    expect(buildFollowUpPrompt("x").system).toContain("产物要怎么给");
    expect(buildDoPrompt("y", []).system).toContain("产物要怎么给");
  });

  it("历史被截断时把「你看不到全部」告诉模型", () => {
    expect(buildFollowUpPrompt("x", true).system).toContain("更早的对话已省略");
    expect(buildFollowUpPrompt("x", false).system).not.toContain("更早的对话已省略");
  });
});

describe("parseAskReply（把模型输出拆成正文 + 提问卡）", () => {
  it("没有标记块 → 全是正文，没有问题", () => {
    const got = parseAskReply("好的，这就做。");
    expect(got.text).toBe("好的，这就做。");
    expect(got.questions).toEqual([]);
  });

  it("⭐ 正文与提问块分开：正文里不该留标记", () => {
    const raw = `在动笔前我想确认一下。\n${ASK_OPEN}\n受众是谁？\n- 老板 | 会更正式\n- 同事 | 会口语些\n${ASK_CLOSE}`;
    const got = parseAskReply(raw);
    expect(got.text).toBe("在动笔前我想确认一下。");
    expect(got.text).not.toContain(ASK_OPEN);
    expect(got.questions).toHaveLength(1);
    expect(got.questions[0]?.text).toBe("受众是谁？");
    expect(got.questions[0]?.options).toHaveLength(2);
  });

  it("选项的「主文案 | 说明」拆得对", () => {
    const raw = `${ASK_OPEN}\n给谁看？\n- 老板 | 会更正式\n${ASK_CLOSE}`;
    const got = parseAskReply(raw);
    // 只有一个选项的问句会被丢掉（见下一条），这里单独验解析
    expect(got.questions).toEqual([]);
    const two = parseAskReply(`${ASK_OPEN}\n给谁看？\n- 老板 | 会更正式\n- 同事 | 会口语些\n${ASK_CLOSE}`);
    expect(two.questions[0]?.options[0]).toEqual({ label: "老板", hint: "会更正式" });
  });

  it("⭐ 只有一个选项的问句**不留**（还不如让用户自己写）", () => {
    const got = parseAskReply(`${ASK_OPEN}\n给谁看？\n- 老板 | 会更正式\n${ASK_CLOSE}`);
    expect(got.questions).toEqual([]);
  });

  it("没有选项的问句也不留", () => {
    const got = parseAskReply(`${ASK_OPEN}\n给谁看？\n${ASK_CLOSE}`);
    expect(got.questions).toEqual([]);
  });

  it("多题：按出现顺序，每题最多 3 个选项", () => {
    const raw = [
      ASK_OPEN,
      "给谁看？",
      "- 甲 | a",
      "- 乙 | b",
      "- 丙 | c",
      "- 丁 | d",
      "多长？",
      "- 一页 | 短",
      "- 三页 | 长",
      ASK_CLOSE,
    ].join("\n");
    const got = parseAskReply(raw);
    expect(got.questions).toHaveLength(2);
    expect(got.questions[0]?.options).toHaveLength(3);
    expect(got.questions[1]?.text).toBe("多长？");
  });

  it("标记不完整（只有开头）时按「没有提问块」处理，且标记被抹掉", () => {
    const got = parseAskReply(`正文 ${ASK_OPEN}\n给谁看？`);
    expect(got.questions).toEqual([]);
    expect(got.text).not.toContain(ASK_OPEN);
  });

  it("问句前面的序号会被去掉（模型爱写「1. 」）", () => {
    const got = parseAskReply(`${ASK_OPEN}\n1. 给谁看？\n- 甲 | a\n- 乙 | b\n${ASK_CLOSE}`);
    expect(got.questions[0]?.text).toBe("给谁看？");
  });

  it("空输入不炸", () => {
    expect(parseAskReply("").questions).toEqual([]);
  });
});

describe("describeAnswer", () => {
  it("选了选项：用选项主文案", () => {
    expect(describeAnswer(q({ text: "给谁看？" }), opt("老板", "会更正式"))).toBe("给谁看？ → 老板");
  });

  it("自己写的：用那几句话（去掉首尾空白）", () => {
    expect(describeAnswer(q({ text: "给谁看？" }), undefined, "  给投资人  ")).toBe("给谁看？ → 给投资人");
  });

  it("⭐ 成句里带箭头 —— 第二段与「最近」列表都靠这个形状识别它是一条回答", () => {
    expect(describeAnswer(q(), opt("甲"))).toContain(" → ");
  });

  it("没选项又没自己写：给一个空答案也不崩", () => {
    expect(describeAnswer(q({ text: "给谁看？" }), undefined)).toBe("给谁看？ → ");
  });
});

describe("资料（@ 添加资料）随请求一起过去", () => {
  const block = "【提到的文件】\n- D:\\a.md：\n季度总结：营收增长 12%";

  it("提问那轮带上资料（不然模型会拿着资料提问、然后不带资料干活）", () => {
    const { user } = buildAskPrompt("把这份资料整理成 PPT", [], block);
    expect(user).toContain("把这份资料整理成 PPT");
    expect(user).toContain("营收增长 12%");
  });

  it("干活那轮也带上（跨过「先问再干」那次往返）", () => {
    const { user } = buildDoPrompt("做周报", ["受众 → 老板"], block);
    expect(user).toContain("我提供的关键信息：");
    expect(user).toContain("营收增长 12%");
  });

  it("接着说那轮也带上", () => {
    const { user } = buildFollowUpPrompt("再改一版", false, block);
    expect(user).toContain("再改一版");
    expect(user).toContain("营收增长 12%");
  });

  it("没资料的调用方行为一个字不变（空/空白都算没资料）", () => {
    expect(buildAskPrompt("x").user).toBe("x");
    expect(buildAskPrompt("x", [], "").user).toBe("x");
    expect(buildAskPrompt("x", [], "   ").user).toBe("x");
    expect(buildFollowUpPrompt("y").user).toBe("y");
  });
});
