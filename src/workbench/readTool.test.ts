import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODEL_MAX_CHARS, READ_MAX_BYTES, describeReadResult, readFileForModel } from "@engine/runtime/tools/readTool";
import { removeAll } from "../testFs";

/**
 * agent 的「读文件」工具（2026-10-14）。
 *
 * 它补的是一个**核心缺口**：在此之前 agent 看不见用户提到的任何文件 ——
 * "把云盘里的季度总结改成三行"这种话它只能编。
 *
 * 这里钉的是**行为**（不是"函数存在"）：
 *   · 目录里的文本读得到、内容一字不差；
 *   · **目录外一律读不到**（与 `drive:read` 同一道白名单）；
 *   · 目录不是文件、空文件、二进制、超大都**如实回报原因**（不返回空串让模型猜）。
 */
let ROOT = "";
let OUTSIDE = "";

beforeAll(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "readtool-"));
  OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "readtool-out-"));
  fs.mkdirSync(path.join(ROOT, "drive"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "drive", "季度总结.md"), "# 季度总结\n\n营收增长 12%\n", "utf8");
  fs.writeFileSync(path.join(ROOT, "drive", "空.txt"), "", "utf8");
  fs.writeFileSync(path.join(ROOT, "drive", "大.txt"), "甲".repeat(READ_MAX_BYTES + 100), "utf8");
  fs.writeFileSync(path.join(ROOT, "drive", "二进制.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01, 0xff, 0xfe]));
  fs.writeFileSync(path.join(OUTSIDE, "别人的文件.md"), "不该被读到", "utf8");
});

afterAll(() => {
  removeAll(ROOT);
  removeAll(OUTSIDE);
});

const dirs = () => [path.join(ROOT, "drive")];

describe("readFileForModel", () => {
  it("读到目录里的文本，内容一字不差", async () => {
    const got = await readFileForModel(path.join(ROOT, "drive", "季度总结.md"), dirs());
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.text).toContain("营收增长 12%");
      expect(got.truncated).toBe(false);
      expect(got.chars).toBe(got.totalChars);
    }
  });

  it("⭐ 目录之外一律读不到（白名单与 drive:read 是同一道）", async () => {
    const got = await readFileForModel(path.join(OUTSIDE, "别人的文件.md"), dirs());
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("不在可读范围内");
  });

  it("**不靠前缀绕过**：`drive-evil` 这种同名前缀目录不算在自己目录里", async () => {
    const sibling = path.join(ROOT, "drive-evil");
    fs.mkdirSync(sibling, { recursive: true });
    const file = path.join(sibling, "x.md");
    fs.writeFileSync(file, "伪装成 drive 的邻居", "utf8");
    const got = await readFileForModel(file, dirs());
    expect(got.ok).toBe(false);
  });

  it("不存在的文件如实说（不是返回空内容）", async () => {
    const got = await readFileForModel(path.join(ROOT, "drive", "没有这个.md"), dirs());
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("不存在");
  });

  it("目录不是文件 —— 说清区别（否则模型会反复试）", async () => {
    const got = await readFileForModel(path.join(ROOT, "drive"), dirs());
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("目录");
  });

  it("空文件：读得到，但内容是空的（调用方看得出这是空文件）", async () => {
    const got = await readFileForModel(path.join(ROOT, "drive", "空.txt"), dirs());
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.text.trim()).toBe("");
  });

  it("二进制文件不喂垃圾给模型（如实说读不了）", async () => {
    const got = await readFileForModel(path.join(ROOT, "drive", "二进制.bin"), dirs());
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("二进制");
  });

  it("超大文件如实说多大（不硬读）", async () => {
    const got = await readFileForModel(path.join(ROOT, "drive", "大.txt"), dirs());
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("太大");
  });

  it("超长正文截断，并**注明原文长度**（模型据此知道自己只看到一部分）", async () => {
    const long = path.join(ROOT, "drive", "长.md");
    fs.writeFileSync(long, "乙".repeat(MODEL_MAX_CHARS + 5000), "utf8");
    const got = await readFileForModel(long, dirs());
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.chars).toBe(MODEL_MAX_CHARS);
      expect(got.truncated).toBe(true);
      expect(got.totalChars).toBe(MODEL_MAX_CHARS + 5000);
    }
  });
});

describe("按文件名找（模型经常只知道名字，不知道路径）", () => {
  it("名字唯一时找得到 —— 于是「云盘里的季度总结.md」这种说法也能读", async () => {
    const got = await readFileForModel("季度总结.md", dirs());
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.text).toContain("营收增长 12%");
  });

  it("带子目录也能对（`子目录/文件名`）", async () => {
    const sub = path.join(ROOT, "drive", "报告");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "月报.md"), "月报正文", "utf8");
    const got = await readFileForModel("报告/月报.md", dirs());
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.text).toContain("月报正文");
  });

  it("⭐ 同名多个**不猜** —— 把候选列出来让模型挑（猜错会读错文件还理直气壮）", async () => {
    const sub = path.join(ROOT, "drive", "旧版");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "季度总结.md"), "旧版内容", "utf8");
    const got = await readFileForModel("季度总结.md", dirs());
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.error).toContain("同名");
      expect(got.error).toContain("旧版");
    }
  });

  it("名字找不到时如实说（并提示可以给完整路径）", async () => {
    const got = await readFileForModel("查无此件.md", dirs());
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("没找到");
  });

  it("**绝对路径优先**：即便同名文件存在，给的路径说了算", async () => {
    const got = await readFileForModel(path.join(ROOT, "drive", "旧版", "季度总结.md"), dirs());
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.text).toContain("旧版内容");
  });

  it("绝对路径但目录外 → 仍然读不到（按名字那条路不能把边界放松）", async () => {
    const got = await readFileForModel(path.join(OUTSIDE, "别人的文件.md"), dirs());
    expect(got.ok).toBe(false);
  });
});

describe("describeReadResult（界面留痕与给模型的说法是同一句）", () => {
  it("成功：说清读了哪个文件、多少字", async () => {
    const got = await readFileForModel(path.join(ROOT, "drive", "季度总结.md"), dirs());
    expect(describeReadResult(got, "D:/x/季度总结.md")).toContain("季度总结.md");
  });

  it("失败：说清读不了哪个文件、为什么", async () => {
    const got = await readFileForModel(path.join(OUTSIDE, "别人的文件.md"), dirs());
    const line = describeReadResult(got, path.join(OUTSIDE, "别人的文件.md"));
    expect(line).toContain("读不了");
    expect(line).toContain("别人的文件.md");
    expect(line).toContain("不在可读范围内");
  });

  it("截断时把「前 N 字 / 原文 M 字」写进那句话", async () => {
    const long = path.join(ROOT, "drive", "长2.md");
    fs.writeFileSync(long, "丙".repeat(MODEL_MAX_CHARS + 10), "utf8");
    const got = await readFileForModel(long, dirs());
    expect(describeReadResult(got, long)).toContain("原文");
  });
});
