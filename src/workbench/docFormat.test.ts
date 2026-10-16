import { describe, expect, it } from "vitest";
import {
  DOC_FORMATS,
  DOC_FORMAT_LABEL,
  DOC_KEYBOARD_LABELS,
  DOC_TONES,
  DOC_TONE_LABEL,
  applyFormat,
  isFormatApplied,
  linesInRange,
  toneInstruction,
} from "@shared/docFormat";

/**
 * AI 文档的「调整语气」与「调整格式」（§168）。
 *
 * 断言对着 `docs/evidence-aidoc.txt`（`aiDoc_keyboard_actionBar_*`，逐字）。  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 *
 * ⚠️ 这一层里**只有格式是纯本地的**（语气要调模型）——
 * 所以下面测的都是"格式变换对不对"，语气那边只测"指令拼得对不对"。
 */
describe("文案与本体对齐（逐字取自 aiDoc_keyboard_actionBar_*）", () => {
  it("两个菜单的标题", () => {
    expect(DOC_KEYBOARD_LABELS.tone).toBe("调整语气");
    expect(DOC_KEYBOARD_LABELS.tools).toBe("调整格式");
  });

  it("五个语气档逐字", () => {
    expect(DOC_TONES).toEqual(["academic", "conversational", "flair", "professional", "socialMedia"]);
    expect(DOC_TONE_LABEL.academic).toBe("更学术");
    expect(DOC_TONE_LABEL.conversational).toBe("更口语化");
    expect(DOC_TONE_LABEL.flair).toBe("更有文采");
    expect(DOC_TONE_LABEL.professional).toBe("更专业");
    expect(DOC_TONE_LABEL.socialMedia).toBe("更有网感");
  });

  it("四个格式档逐字（标题 / 小标题 / 副标题 / 正文）", () => {
    expect(DOC_FORMATS).toEqual(["h1", "h2", "h3", "text"]);
    expect(DOC_FORMAT_LABEL.h1).toBe("标题");
    expect(DOC_FORMAT_LABEL.h2).toBe("小标题");
    expect(DOC_FORMAT_LABEL.h3).toBe("副标题");
    expect(DOC_FORMAT_LABEL.text).toBe("正文");
  });
});

describe("toneInstruction（只是拼指令，不调模型）", () => {
  it("每个档都有各自的说法（不能五个档发同一句）", () => {
    const all = DOC_TONES.map((t) => toneInstruction(t));
    expect(new Set(all).size).toBe(DOC_TONES.length);
  });

  it("⭐ 都要求「只改表达、不改事实与结构」—— 否则改语气会顺手改内容", () => {
    for (const t of DOC_TONES) {
      expect(toneInstruction(t)).toContain("保持原文的事实、观点与结构不变");
    }
  });

  it("都要求直接给全文、不要解释", () => {
    expect(toneInstruction("professional")).toContain("直接给出改后的全文");
  });

  it("口语化那一档明确**不许**加表情与黑话（否则会加一堆 emoji）", () => {
    expect(toneInstruction("conversational")).toContain("不要加表情符号");
  });
});

describe("linesInRange（选区 → 整行）", () => {
  const body = "第一行\n第二行\n第三行";

  it("光标落在某一行 → 就动那一行", () => {
    expect(linesInRange(body, { start: 5, end: 5 })).toEqual({ from: 1, to: 1 });
  });

  it("⭐ 只选了半句 → 也把那一整行算上（否则会切出一个半个标题）", () => {
    // 选 "第二" 两个字
    expect(linesInRange(body, { start: 4, end: 6 })).toEqual({ from: 1, to: 1 });
  });

  it("跨行选区覆盖到两端所在的行", () => {
    expect(linesInRange(body, { start: 1, end: 9 })).toEqual({ from: 0, to: 2 });
  });

  it("⭐ 选区正好结束在行首 → 不把下一行带上（编辑器里的常规做法）", () => {
    // 选到第一行末尾（含换行符）
    expect(linesInRange(body, { start: 0, end: 4 })).toEqual({ from: 0, to: 0 });
  });

  it("越界的下标不炸", () => {
    expect(linesInRange(body, { start: 999, end: 999 })).toEqual({ from: 2, to: 2 });
    expect(linesInRange(body, { start: -5, end: -5 })).toEqual({ from: 0, to: 0 });
  });
});

describe("applyFormat（纯本地，不调模型）", () => {
  it("给某一行加小标题标记", () => {
    const body = "第一行\n第二行\n第三行";
    expect(applyFormat(body, "h2", { start: 5, end: 5 })).toBe("第一行\n## 第二行\n第三行");
  });

  it("⭐ 已有的标记会被替换，不会叠加成 `### ## 小标题`", () => {
    expect(applyFormat("# 老标题", "h3")).toBe("### 老标题");
  });

  it("正文 = 去掉标记", () => {
    expect(applyFormat("## 小标题", "text")).toBe("小标题");
  });

  it("⭐ 空行不动（否则会得到一堆孤零零的 `# `）", () => {
    const got = applyFormat("甲\n\n乙", "h1");
    expect(got).toBe("# 甲\n\n# 乙");
  });

  it("⭐ 没变化时**返回原串**（免得平白多一个历史版本）", () => {
    const body = "# 已经是标题";
    expect(applyFormat(body, "h1")).toBe(body);
  });

  it("空文档原样返回", () => {
    expect(applyFormat("   ", "h1")).toBe("   ");
  });

  it("多行被选中时只动被覆盖到的行", () => {
    const body = "甲\n乙\n丙";
    // 选到「乙」为止（不含第三个换行），所以丙不动
    expect(applyFormat(body, "h2", { start: 0, end: 3 })).toBe("## 甲\n## 乙\n丙");
    // 全选（end 越过末尾）则三行都加
    expect(applyFormat(body, "h2", { start: 0, end: body.length })).toBe("## 甲\n## 乙\n## 丙");
  });

  it("缩进过的标题也能规整（不会变成 `  ## 标题`）", () => {
    expect(applyFormat("   ## 缩进的标题", "h3")).toBe("### 缩进的标题");
  });

  it("四个档位各加各的标记", () => {
    expect(applyFormat("甲", "h1")).toBe("# 甲");
    expect(applyFormat("甲", "h2")).toBe("## 甲");
    expect(applyFormat("甲", "h3")).toBe("### 甲");
    expect(applyFormat("甲", "text")).toBe("甲");
  });
});

describe("isFormatApplied", () => {
  it("已经是该格式 → true（界面据此判断「点了会不会变」）", () => {
    expect(isFormatApplied("## 小标题", "h2")).toBe(true);
  });

  it("不是该格式 → false", () => {
    expect(isFormatApplied("小标题", "h2")).toBe(false);
    expect(isFormatApplied("# 标题", "h2")).toBe(false);
  });
});
