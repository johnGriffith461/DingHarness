import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WRITE_MAX_CHARS, describeWriteResult, resolveWriteTarget, writeFileForModel } from "@engine/runtime/tools/writeTool";
import { removeAll } from "../testFs";

/**
 * agent 的「写文件」工具（2026-10-14）。
 *
 * 它补的是 `read_file` / `list_files` 之后仍然缺的那一半：agent 能**看**了，
 * 但"把内容整理成一份文件留给他"这件事还做不到 —— 产出只能吐在对话里。
 *
 * 这里钉的是**行为**，而且大都是**拒绝**行为 —— 写文件是不可逆的那一类：
 *   · 目录里新建得到、内容一字不差、且**真落到了磁盘**（不是只在返回值里说成功）；
 *   · 子目录会自动建（"整理进 deliveries/" 这类任务要用），但仍在白名单之内；
 *   · **默认不覆盖**：同名文件在 → 报错且原文件**一个字节都没变**；
 *     `overwrite:true` 才覆盖，并且能区分"新建"与"覆盖"（返回值 + 那句话）；
 *   · 目录外一律写不了（与 `drive:read` 同一道白名单，**穿越路径也不认**）；
 *   · 二进制扩展名、正文超长、目标是目录 —— 各自给**能照着做**的理由，不糊成一句"失败"。
 */
let ROOT = "";
let OUTSIDE = "";

beforeAll(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "writetool-"));
  OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "writetool-out-"));
  fs.mkdirSync(path.join(ROOT, "drive"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, "artifacts"), { recursive: true });
  fs.mkdirSync(path.join(OUTSIDE, "别人家"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "drive", "已有.md"), "原来的内容", "utf8");
  fs.mkdirSync(path.join(ROOT, "drive", "一个目录"), { recursive: true });
});

afterAll(() => {
  removeAll(ROOT);
  removeAll(OUTSIDE);
});

/** 本测试里的"用户目录"。 */
const dirs = () => [path.join(ROOT, "drive"), path.join(ROOT, "artifacts")];

describe("写进去", () => {
  it("新建：返回落点、字数、`created=true`，而且**盘上真有这个文件**", async () => {
    const target = path.join(ROOT, "drive", "纪要.md");
    const r = await writeFileForModel(target, "# 纪要\n\n- 甲\n- 乙\n", dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(true);
    expect(r.path).toBe(target);
    /* 4 + 1 + 1 + 3 + 1 + 3 + 1 = 14（数出来的一行，不是抄来的） */
    expect(r.chars).toBe(14);
    /* ⭐ 关键：不是「函数说成功了」，而是**磁盘上真读得回来、一字不差** */
    expect(fs.readFileSync(target, "utf8")).toBe("# 纪要\n\n- 甲\n- 乙\n");
  });

  it("中文按 UTF-8 记字节数（3 字节/字）——`chars` 与 `bytes` 不是一回事", async () => {
    const target = path.join(ROOT, "drive", "中文.txt");
    const r = await writeFileForModel(target, "甲乙丙", dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chars).toBe(3);
    expect(r.bytes).toBe(9);
  });

  it("产物目录也能写（与云盘同一条白名单，不是只认 drive/）", async () => {
    const target = path.join(ROOT, "artifacts", "报告.md");
    const r = await writeFileForModel(target, "报告", dirs());
    expect(r.ok).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("子目录会自动建（「整理进 deliveries/」这类任务要用）", async () => {
    const target = path.join(ROOT, "drive", "deliveries", "本周", "清单.md");
    const r = await writeFileForModel(target, "- 事项一", dirs());
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("- 事项一");
  });

  it("空正文也写得进去（「先建个空文件」是合法请求，不该被当成错误）", async () => {
    const target = path.join(ROOT, "drive", "空文件.md");
    const r = await writeFileForModel(target, "", dirs());
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("");
  });
});

describe("拒绝的每一条都要有理由", () => {
  it("⭐ 默认不覆盖：同名文件在 → 报错，且**原文件一个字节都没变**", async () => {
    const target = path.join(ROOT, "drive", "已有.md");
    const r = await writeFileForModel(target, "被改掉的内容", dirs());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("同名文件");
    /* 只说"拒绝了"不够 —— 要证明**没动过** */
    expect(fs.readFileSync(target, "utf8")).toBe("原来的内容");
  });

  it("显式 overwrite 才覆盖，且能区分「覆盖」与「新建」", async () => {
    const target = path.join(ROOT, "drive", "已有.md");
    const r = await writeFileForModel(target, "覆盖后的内容", dirs(), true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("覆盖后的内容");
  });

  it("⭐ 目录外写不了 —— 而且 `../` 穿越也不认（白名单判的是**最终落点**）", async () => {
    const direct = await writeFileForModel(path.join(OUTSIDE, "别人家", "x.md"), "不该写", dirs());
    expect(direct.ok).toBe(false);

    const escaped = await writeFileForModel(path.join(ROOT, "drive", "..", "..", "穿越.md"), "不该写", dirs());
    expect(escaped.ok).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "穿越.md"))).toBe(false);
  });

  it("目标是目录 → 单独说清（不是「不存在」，是「这个工具不干这个」）", async () => {
    const r = await writeFileForModel(path.join(ROOT, "drive", "一个目录"), "x", dirs());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("目录");
  });

  it("二进制扩展名直接拒绝，并把「该用什么」说出来", async () => {
    const r = await writeFileForModel(path.join(ROOT, "drive", "图.png"), "这不是真的 png", dirs());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("文本");
    expect(fs.existsSync(path.join(ROOT, "drive", "图.png"))).toBe(false);
  });

  it("认不出来的扩展名**照样放行**（黑名单不是白名单：`.log` / 无扩展名都该能写）", async () => {
    const a = await writeFileForModel(path.join(ROOT, "drive", "运行.log"), "一行日志", dirs());
    const b = await writeFileForModel(path.join(ROOT, "drive", "NOTES"), "没有扩展名", dirs());
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("正文超上限 → 报错并建议拆开（不是默默截断 —— 写进去的东西用户得能读到全的）", async () => {
    const r = await writeFileForModel(path.join(ROOT, "drive", "太大.md"), "甲".repeat(WRITE_MAX_CHARS + 1), dirs());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("太长");
    expect(fs.existsSync(path.join(ROOT, "drive", "太大.md"))).toBe(false);
  });

  it("刚好等于上限是**允许**的（边界不能少一格）", async () => {
    const r = await writeFileForModel(path.join(ROOT, "drive", "刚好.md"), "甲".repeat(WRITE_MAX_CHARS), dirs());
    expect(r.ok).toBe(true);
  });
});

describe("describeWriteResult（界面留痕与回给模型共用这一句）", () => {
  it("新建与覆盖说法不同（用户要看得出这次是动了已有的东西）", () => {
    const created = describeWriteResult({ ok: true, path: "D:/x/云盘/纪要.md", chars: 12, bytes: 18, created: true }, "x");
    const overwritten = describeWriteResult({ ok: true, path: "D:/x/云盘/纪要.md", chars: 12, bytes: 18, created: false }, "x");
    expect(created).toContain("新建");
    expect(overwritten).toContain("覆盖");
    expect(created).not.toBe(overwritten);
  });

  it("失败时把原因带上（不能只说「写不了」）", () => {
    const line = describeWriteResult({ ok: false, error: "已经有一个同名文件了" }, "D:/x/云盘/纪要.md");
    expect(line).toContain("纪要.md");
    expect(line).toContain("同名文件");
  });
});

/*
 * 「只给文件名」这条路（2026-10-14 补）。
 *
 * 模型**不知道** `<userData>/drive/` 这串绝对路径 —— `read_file` 那边已经因为
 * "只认绝对路径"而在真实对话里用不起来。写文件同样：用户说"存成一份纪要"，
 * 模型手上只有"纪要.md"。所以只给名字时要落到可写目录的第一个（云盘根）。
 */
describe("resolveWriteTarget：只给文件名也能落对地方", () => {
  it("裸文件名 → 落到第一个可写目录（云盘根）", () => {
    expect(resolveWriteTarget("纪要.md", dirs())).toBe(path.join(ROOT, "drive", "纪要.md"));
  });

  it("带目录的绝对路径 → 原样过白名单", () => {
    expect(resolveWriteTarget(path.join(ROOT, "artifacts", "x.md"), dirs())).toBe(path.join(ROOT, "artifacts", "x.md"));
  });

  it("⭐ 裸名字里塞 `..` 也跑不出去（拼完照样过白名单）", () => {
    expect(resolveWriteTarget("../../穿越.md", dirs())).toBeNull();
    expect(resolveWriteTarget("..\..\穿越.md", dirs())).toBeNull();
  });

  it("没有可写目录 → 拒绝（不猜一个地方写）", () => {
    expect(resolveWriteTarget("纪要.md", [])).toBeNull();
  });

  it("空路径 → 拒绝", () => {
    expect(resolveWriteTarget("   ", dirs())).toBeNull();
  });

  it("端到端：裸名字真能写进去", async () => {
    const r = await writeFileForModel("裸名字.md", "内容", dirs());
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(ROOT, "drive", "裸名字.md"), "utf8")).toBe("内容");
  });
});
