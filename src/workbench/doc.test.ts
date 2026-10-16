import { describe, expect, it } from "vitest";
import {
  DOC_BAR_LABELS,
  DOC_CREATE_LABELS,
  DOC_VERSION_LIMIT,
  DOC_VERSION_MERGE_MS,
  attachmentLink,
  insertAt,
  docFromMessage,
  DOC_ACTIONS,
  DOC_ACTION_LABEL,
  DOC_TEXT_PLACEHOLDER,
  DOC_TITLE_LIMIT,
  DOC_TITLE_PLACEHOLDER,
  UNTITLED_DOC,
  applyDocEdit,
  defaultExportName,
  docActionInstruction,
  docTitle,
  makeDoc,
  normalizeDocs,
  restoreDocVersion,
  versionStamp,
} from "@shared/doc";

/**
 * AI 文档的纯逻辑（§152）。
 *
 * ⚠️ 这里的文案断言不是"我自己定的规矩"，而是**本体前端包里的原文**
 * （`docs/evidence-aidoc.txt`）。改文案时如果对不上，就是与本体脱钩了 ——  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 * 所以这些断言同时是"证据仍然对齐"的守卫。
 */
const NOW = 1_700_000_000_000;

describe("文案与本体对齐（逐字取自 aiDoc_* 证据）", () => {
  it("功能名与四个操作条标签", () => {
    expect(DOC_ACTIONS).toEqual(["concise", "longer", "refine", "summary"]);
    expect(DOC_ACTION_LABEL).toEqual({ concise: "缩写", longer: "扩写", refine: "润色", summary: "总结概括" });
  });

  it("空态占位与兜底标题", () => {
    expect(DOC_TITLE_PLACEHOLDER).toBe("添加标题");
    expect(DOC_TEXT_PLACEHOLDER).toBe("记录你的想法");
    expect(UNTITLED_DOC).toBe("未命名文档");
  });

  it("标题口径与任务标题一致（16 字）", () => {
    expect(DOC_TITLE_LIMIT).toBe(16);
  });
});

describe("makeDoc", () => {
  it("新文档带一个初始版本（历史里「创建了文档」那一行要有东西可指）", () => {
    const doc = makeDoc("d1", NOW);
    expect(doc.versions).toHaveLength(1);
    expect(doc.versions[0]?.reason).toBe("创建了文档");
    expect(doc.body).toBe("");
  });

  it("标题空着（界面显示占位，而不是把占位文字写进数据）", () => {
    expect(makeDoc("d1", NOW).title).toBe("");
    expect(docTitle(makeDoc("d1", NOW))).toBe(UNTITLED_DOC);
  });
});

describe("applyDocEdit", () => {
  it("改一次记一版，并且**新版本里是改后的内容**", () => {
    const doc = applyDocEdit(makeDoc("d1", NOW), { body: "第一段" }, "编辑", NOW + 1);
    expect(doc.body).toBe("第一段");
    expect(doc.versions).toHaveLength(2);
    expect(doc.versions[1]?.body).toBe("第一段");
    expect(doc.versions[1]?.reason).toBe("编辑");
  });

  it("⭐ 内容没变就不记新版本（否则点一下按钮就多一条历史）", () => {
    const doc = makeDoc("d1", NOW);
    expect(applyDocEdit(doc, { body: "" }, "编辑", NOW + 1)).toBe(doc);
  });

  it("只改标题时正文版本也一起记（历史是整篇快照，不是差量）", () => {
    const doc = applyDocEdit(makeDoc("d1", NOW), { title: "周报" }, "编辑", NOW + 1);
    expect(doc.versions[1]?.title).toBe("周报");
    expect(doc.title).toBe("周报");
  });

  it("版本号单调递增（历史靠它排序与定位）", () => {
    let doc = makeDoc("d1", NOW);
    doc = applyDocEdit(doc, { body: "一" }, "编辑", NOW + 1);
    doc = applyDocEdit(doc, { body: "二" }, "润色", NOW + 2);
    expect(doc.versions.map((v) => v.v)).toEqual([0, 1, 2]);
  });

  it("updatedAt 跟着走（「已保存」与导出文件名都用它）", () => {
    expect(applyDocEdit(makeDoc("d1", NOW), { body: "x" }, "编辑", NOW + 5).updatedAt).toBe(NOW + 5);
  });
});

describe("restoreDocVersion（回到此版本）", () => {
  it("内容回到那一版", () => {
    let doc = makeDoc("d1", NOW);
    doc = applyDocEdit(doc, { body: "甲", title: "A" }, "编辑", NOW + 1);
    doc = applyDocEdit(doc, { body: "乙", title: "B" }, "润色", NOW + 2);
    const back = restoreDocVersion(doc, 1, NOW + 3);
    expect(back.body).toBe("甲");
    expect(back.title).toBe("A");
  });

  it("⭐ 是「再写一遍」，不是把中间版本删掉（历史单调，误还原也能再还原）", () => {
    let doc = makeDoc("d1", NOW);
    doc = applyDocEdit(doc, { body: "甲" }, "编辑", NOW + 1);
    doc = applyDocEdit(doc, { body: "乙" }, "润色", NOW + 2);
    const back = restoreDocVersion(doc, 1, NOW + 3);
    // 版本只增不减，且"甲/乙"都还在
    expect(back.versions.map((v) => v.v)).toEqual([0, 1, 2, 3]);
    expect(back.versions.some((v) => v.body === "乙")).toBe(true);
    expect(back.versions[3]?.reason).toBe("还原自 v1 的版本");
  });

  it("版本号不存在时原样返回（磁盘来的东西不可信）", () => {
    const doc = makeDoc("d1", NOW);
    expect(restoreDocVersion(doc, 99, NOW + 1)).toBe(doc);
  });
});

describe("操作条指令", () => {
  it("四个动作各有自己的指令（不能四个按钮发同一句话）", () => {
    const texts = DOC_ACTIONS.map((a) => docActionInstruction(a));
    expect(new Set(texts).size).toBe(4);
    expect(texts[0]).toContain("缩写");
    expect(texts[1]).toContain("扩写");
    expect(texts[2]).toContain("润色");
    expect(texts[3]).toContain("总结");
  });

  it("⭐ 都写明「只输出正文」——不然结果没法直接替换进去", () => {
    for (const a of DOC_ACTIONS) {
      const t = docActionInstruction(a);
      expect(t).toContain("只输出改完之后的正文本身");
      expect(t).toContain("不要用代码块");
    }
  });
});

describe("小工具", () => {
  it("历史时间按「月日」显示", () => {
    expect(versionStamp(Date.UTC(2026, 9, 13))).toMatch(/月\d+日$/);
  });

  it("导出默认名带标题与日期（没有标题就回落「未命名文档」）", () => {
    const doc = applyDocEdit(makeDoc("d1", NOW), { body: "x", title: "周报" }, "编辑", NOW + 1);
    expect(defaultExportName(doc)).toContain("周报");
    expect(defaultExportName(makeDoc("d1", NOW))).toContain(UNTITLED_DOC);
  });
});


describe("从对话创建文档（§172）", () => {
  it("文案逐字取自证据（`aiDoc_msgLongPressMenu_*` / `aiDoc_*_placeholder`）", () => {
    expect(DOC_CREATE_LABELS.create).toBe("创建文档");
    expect(DOC_CREATE_LABELS.failed).toBe("文档创建失败");
    expect(DOC_CREATE_LABELS.created).toBe("已为你创建文档。你想如何调整这篇文档？请随时告诉我。");
  });

  it("标题取第一行非空文本", () => {
    expect(docFromMessage("第一条\n第二条")?.title).toBe("第一条");
  });

  it("开头的空行不算（不能拿一个空标题）", () => {
    expect(docFromMessage("\n\n  真正的第一行\n第二行")?.title).toBe("真正的第一行");
  });

  it("⭐ 正文**原样保留** —— 这是用户看见过的那条回复，改一个字都是篡改记录", () => {
    const src = "第一行\n\n  缩进的第二行  \n结尾";
    expect(docFromMessage(src)?.body).toBe(src);
  });

  it("标题太长会截（列表里不该出现一整段当标题）", () => {
    const long = "标题".repeat(40);
    expect((docFromMessage(long)?.title ?? "").length).toBeLessThanOrEqual(16);
  });

  it("⭐ 空消息给 null（调用方据此说「文档创建失败」，而不是造一篇空文档）", () => {
    expect(docFromMessage("")).toBeNull();
    expect(docFromMessage("   \n  ")).toBeNull();
  });

  it("只有一行时标题与正文都来自它", () => {
    const got = docFromMessage("只有一行");
    expect(got?.title).toBe("只有一行");
    expect(got?.body).toBe("只有一行");
  });
});


describe("粘贴 / 插入附件（§173）", () => {
  it("文案逐字取自证据", () => {
    expect(DOC_BAR_LABELS.paste).toBe("粘贴");
    expect(DOC_BAR_LABELS.attach).toBe("插入附件");
    expect(DOC_BAR_LABELS.newDoc).toBe("新建文档");
  });

  it("⭐ 剪贴板空的时候**有话说**（自定那句）—— 点了没反应最糟", () => {
    expect(DOC_BAR_LABELS.pasteEmpty).toBe("剪贴板里没有文字");
  });
});

describe("insertAt", () => {
  it("有选区 → **替换**选区（不是插在旁边）", () => {
    expect(insertAt("abcdef", { start: 1, end: 3 }, "XY")).toBe("aXYdef");
  });

  it("没有选区（光标）→ 插在那个位置", () => {
    expect(insertAt("abcdef", { start: 3, end: 3 }, "XY")).toBe("abcXYdef");
  });

  it("完全没给选区 → 接在末尾", () => {
    expect(insertAt("abc", undefined, "XY")).toBe("abcXY");
  });

  it("空正文也能插", () => {
    expect(insertAt("", undefined, "XY")).toBe("XY");
  });

  it("越界不炸（钳到两端）", () => {
    expect(insertAt("abc", { start: -5, end: -1 }, "X")).toBe("Xabc");
    expect(insertAt("abc", { start: 99, end: 200 }, "X")).toBe("abcX");
  });

  it("起点大于终点时按起点算（不切成反的）", () => {
    expect(insertAt("abc", { start: 2, end: 1 }, "X")).toBe("abXc");
  });
});

describe("attachmentLink", () => {
  it("造的是 `dshasset://file/<origin>/<名字>` 那条协议（与云盘「复制链接」同一条）", () => {
    expect(attachmentLink("周报.md", "drive")).toBe("[周报.md](dshasset://file/drive/%E5%91%A8%E6%8A%A5.md)");
  });

  it("⭐ 中文名要编码 —— 那条协议把名字放在 path 里，不编码会被截断", () => {
    const link = attachmentLink("设计稿 v2.png", "artifact");
    expect(link).toContain("dshasset://file/artifact/");
    /*
     * ⚠️ 空格在**显示文字**里是该留的（`[设计稿 v2.png]`）；
     * 要干净的是 **URL 那一段** —— 所以按 `](` 切开只看后面。
     */
    const url = link.slice(link.indexOf("](") + 2, -1);
    expect(url).not.toContain(" ");
    expect(url).toContain("%20");
  });

  it("名字空的时候给个兜底（不造一个空链接）", () => {
    expect(attachmentLink("", "drive")).toContain("附件");
  });

  it("origin 空的时候退回 drive（不造一条取不到文件的链接）", () => {
    expect(attachmentLink("a.md", "")).toContain("dshasset://file/drive/");
  });
});

describe("历史版本的上限与合并（P18）", () => {
  const edit = (doc: ReturnType<typeof makeDoc>, body: string, now: number) => applyDocEdit(doc, { body }, "编辑正文", now);

  it("⭐ 连打一串字**合并成一版**（不是每敲一键 append 一份全文）", () => {
    let doc = makeDoc("d1", NOW);
    // 模拟逐键输入：每 50ms 一个字符，都在合并窗口内
    for (let i = 0; i < 20; i += 1) doc = edit(doc, "字".repeat(i + 1), NOW + i * 50);
    expect(doc.body).toBe("字".repeat(20));
    /*
     * 旧实现：versions 会有 21 条（初版 + 20 次击键）。
     * 现在：同源且连续的改动并上一版，所以只剩 2 条（初版 + 这一次编辑）。
     */
    expect(doc.versions.length).toBe(2);
    expect(doc.versions[doc.versions.length - 1].body).toBe("字".repeat(20));
    // 开头那条「创建了文档」必须留着（历史面板要有起点）
    expect(doc.versions[0].reason).toBe("创建了文档");
  });

  it("隔得够久的同源改动**各记一版**（合并窗口不是永远并在一起）", () => {
    let doc = makeDoc("d2", NOW);
    doc = edit(doc, "第一段", NOW);
    doc = edit(doc, "第一段改了", NOW + DOC_VERSION_MERGE_MS + 1);
    expect(doc.versions.length).toBe(3);
  });

  it("不同来源的改动不合并（AI 动作与手改各是一条历史）", () => {
    let doc = makeDoc("d3", NOW);
    doc = applyDocEdit(doc, { body: "手改" }, "编辑正文", NOW);
    doc = applyDocEdit(doc, { body: "润色后" }, "润色", NOW + 10);
    expect(doc.versions.length).toBe(3);
    expect(doc.versions[2].reason).toBe("润色");
  });

  it("⭐ 版本数有**上限**：超了只留最近的（不再 O(n²) 长下去）", () => {
    let doc = makeDoc("d4", NOW);
    for (let i = 0; i < DOC_VERSION_LIMIT * 3; i += 1) {
      // 每次间隔都超出合并窗口 → 每次都真记一版
      doc = edit(doc, `第 ${i} 稿`, NOW + i * (DOC_VERSION_MERGE_MS + 1));
    }
    expect(doc.versions.length, "版本数没有上限 —— 大文档能把它撑爆").toBe(DOC_VERSION_LIMIT);
    // 留下的必须是**最近**的那些
    expect(doc.versions[doc.versions.length - 1].body).toBe(`第 ${DOC_VERSION_LIMIT * 3 - 1} 稿`);
    // 而当前内容与最后一条版本一致（历史与正文不许脱钩）
    expect(doc.versions[doc.versions.length - 1].body).toBe(doc.body);
  });

  it("从磁盘读回来的超长历史也被截到上限（normalize 那条路同样收口）", () => {
    const many = Array.from({ length: DOC_VERSION_LIMIT + 30 }, (_, i) => ({
      v: i,
      body: `b${i}`,
      title: "",
      at: i,
      reason: "编辑正文",
    }));
    const got = normalizeDocs([{ id: "d5", title: "", body: "b", createdAt: 1, updatedAt: 2, versions: many }]);
    expect(got[0].versions.length).toBe(DOC_VERSION_LIMIT);
  });
});
