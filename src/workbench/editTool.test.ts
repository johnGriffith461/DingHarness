import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeEditResult, editFileForModel } from "@engine/runtime/tools/editTool";
import { removeAll } from "../testFs";

/**
 * agent 的「改文件」工具（2026-10-14）。
 *
 * 为什么必须有它：没有它，agent 改一个已有文件只能把全文读回来、改一个字、
 * 再整篇写回去 —— 中间任何一步出岔子就**把用户整个文件毁了**。
 * 参考实现（opencode 的 `edit` / Cline 的 `replace_in_file`）语义一致：
 * 精确文本替换，默认必须唯一。
 *
 * 这一组钉的是行为，重点在**拒绝**与**不误伤**：
 * 找不到就报错（不猜）、命中多处就失败（不随便挑一处）、行尾不许被顺手改掉。
 */
let ROOT = "";

beforeAll(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "edittool-"));
  fs.mkdirSync(path.join(ROOT, "work"), { recursive: true });
});

afterEach(() => {
  /* 每个用例自己写文件，这里清掉，免得互相看见 */
  for (const f of fs.readdirSync(path.join(ROOT, "work"))) {
    /* 有的用例会建目录：不加 recursive 会 EISDIR，而 afterEach 抛错会把**下一条**测试也判红 */
    removeAll(path.join(ROOT, "work", f));
  }
});

const dirs = () => [path.join(ROOT, "work")];
const file = (name: string) => path.join(ROOT, "work", name);
const put = (name: string, text: string, eol = "\n") =>
  fs.writeFileSync(file(name), eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text, "utf8");

describe("改得对", () => {
  it("唯一命中：那一处被换掉，别处不动", async () => {
    put("a.md", "# 标题\n\n第一段\n\n第二段\n");
    const r = await editFileForModel(file("a.md"), "第一段", "改过的第一段", dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.replaced).toBe(1);
    expect(r.line).toBe(3);
    expect(fs.readFileSync(file("a.md"), "utf8")).toBe("# 标题\n\n改过的第一段\n\n第二段\n");
  });

  it("newText 是空串 = 删掉那一段", async () => {
    put("b.md", "留着\n删掉这段\n留着\n");
    const r = await editFileForModel(file("b.md"), "删掉这段\n", "", dirs());
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(file("b.md"), "utf8")).toBe("留着\n留着\n");
  });

  it("replaceAll 才全改", async () => {
    put("c.md", "甲\n乙\n甲\n乙\n");
    const r = await editFileForModel(file("c.md"), "甲", "丙", dirs(), true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.replaced).toBe(2);
    expect(fs.readFileSync(file("c.md"), "utf8")).toBe("丙\n乙\n丙\n乙\n");
  });

  it("⭐ 行尾保持：CRLF 的文件改完还是 CRLF（不然一次小改就是整文件重写）", async () => {
    put("d.md", "第一行\n第二行\n", "\r\n");
    expect(fs.readFileSync(file("d.md"), "utf8")).toContain("\r\n");
    const r = await editFileForModel(file("d.md"), "第二行", "改过的第二行", dirs());
    expect(r.ok).toBe(true);
    const after = fs.readFileSync(file("d.md"), "utf8");
    expect(after).toBe("第一行\r\n改过的第二行\r\n");
    /* 关键：不许出现"混着"的 LF */
    expect(after.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("模型给的是 LF、文件是 CRLF 也照样命中（最常见的「明明抄对了却找不到」）", async () => {
    put("e.md", "甲\n乙\n", "\r\n");
    const r = await editFileForModel(file("e.md"), "甲\n乙", "丙\n丁", dirs());
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(file("e.md"), "utf8")).toBe("丙\r\n丁\r\n");
  });

  it("只给文件名也行（与写文件同口径）", async () => {
    put("f.md", "旧\n");
    const r = await editFileForModel("f.md", "旧", "新", dirs());
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(file("f.md"), "utf8")).toBe("新\n");
  });
});

describe("拒绝的每一条都要有理由", () => {
  it("⭐ 找不到原文 → 报错，并且**文件一个字节都没动**", async () => {
    put("g.md", "原文是这样的\n");
    const r = await editFileForModel(file("g.md"), "其实不是这样", "x", dirs());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("找不到");
    expect(fs.readFileSync(file("g.md"), "utf8")).toBe("原文是这样的\n");
  });

  it("⭐ 命中多处但没开 replaceAll → 失败，并告诉你在哪几行（不许随便挑一处改）", async () => {
    put("h.md", "同一个词\n别的\n同一个词\n");
    const r = await editFileForModel(file("h.md"), "同一个词", "换掉", dirs());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("2 处");
    expect(r.error).toContain("1");
    expect(r.error).toContain("3");
    expect(fs.readFileSync(file("h.md"), "utf8")).toBe("同一个词\n别的\n同一个词\n");
  });

  it("新旧一样 / 空 oldText → 各自说清，不当成改成功了", async () => {
    put("i.md", "内容\n");
    const same = await editFileForModel(file("i.md"), "内容", "内容", dirs());
    expect(same.ok).toBe(false);
    const empty = await editFileForModel(file("i.md"), "", "x", dirs());
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error).toContain("write_file");
  });

  it("文件不存在 / 越界 / 是目录 → 分别有理由", async () => {
    const missing = await editFileForModel(file("没有这个.md"), "a", "b", dirs());
    expect(missing.ok).toBe(false);
    const outside = await editFileForModel(path.join(ROOT, "外面.md"), "a", "b", dirs());
    expect(outside.ok).toBe(false);
    fs.mkdirSync(file("一个目录"));
    const isDir = await editFileForModel(file("一个目录"), "a", "b", dirs());
    expect(isDir.ok).toBe(false);
  });
});

describe("弯引号容忍（本机自己加的一条）", () => {
  it("中文弯引号抄错一个字符时，能在「忽略排版差异」的口径下改对，并且如实说明", async () => {
    put("j.md", "他说：\u201c就这样吧\u201d。\n");
    /* 模型给的是直引号 —— 逐字匹配必然失败 */
    const r = await editFileForModel(file("j.md"), '他说："就这样吧"。', "他说：「就这样吧」。", dirs());
    /* 打印出来看一眼：断言红的时候得知道**它到底为什么没命中** */
    if (!r.ok) console.log("   （失败原因：" + r.error + "）");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fuzzy).toBe(true);
    expect(fs.readFileSync(file("j.md"), "utf8")).toBe("他说：「就这样吧」。\n");
  });

  it("不是排版差异（真抄错了）仍然失败 —— 不能因为「宽容」就乱改", async () => {
    put("k.md", "完全不同的内容\n");
    const r = await editFileForModel(file("k.md"), "另一句", "x", dirs());
    expect(r.ok).toBe(false);
  });
});

describe("describeEditResult", () => {
  it("一处说行号、多处说处数、容忍匹配要标出来", () => {
    expect(describeEditResult({ ok: true, path: "D:/x/a.md", replaced: 1, line: 7, fuzzy: false }, "a.md")).toContain("第 7 行");
    expect(describeEditResult({ ok: true, path: "D:/x/a.md", replaced: 3, line: 1, fuzzy: false }, "a.md")).toContain("3 处");
    expect(describeEditResult({ ok: true, path: "D:/x/a.md", replaced: 1, line: 1, fuzzy: true }, "a.md")).toContain("引号");
  });

  it("失败时带上原因", () => {
    const line = describeEditResult({ ok: false, error: "找不到那段原文" }, "a.md");
    expect(line).toContain("找不到");
  });
});

/*
 * ⭐ 一条**载荷性不变量**：`normalizeTypography` 必须逐字符 1:1。
 *
 * 因为它决定了"命中的位置"能不能直接从归一化坐标搬回原文坐标 ——
 * 改成一个字符换成两个字符（比如把 `--` 折成一个长破折号）就会**静默错位**：
 * 替换的位置整体偏移，而且偏得很小、测试不专门盯就发现不了。
 * 这条断言不长，但它守着上面那套位置替换的前提。
 */
describe("归一化的长度不变量", () => {
  it("逐字符 1:1（长度不变），否则位置替换会整体错位", async () => {
    const cases = ["“弯引号”", "en–dash", "em—dash", "全角　空格", "nb sp", "普通文本 abc"];
    for (const text of cases) {
      put("invariant.md", text + "\n");
      const r = await editFileForModel(file("invariant.md"), text, "换掉了", dirs());
      expect(r.ok, `归一化后位置错位了：${text}`).toBe(true);
      const after = fs.readFileSync(file("invariant.md"), "utf8");
      expect(after, `只该换掉那一段：${text}`).toBe("换掉了\n");
    }
  });
});
