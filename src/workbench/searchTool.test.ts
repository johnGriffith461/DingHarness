import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LIST_DIR_MAX_DEPTH,
  SEARCH_DEFAULT_LIMIT,
  describeListDirResult,
  describeSearchResult,
  listDirForModel,
  nothingFoundNote,
  searchFilesForModel,
} from "@engine/runtime/tools/searchTool";

/**
 * agent 的「找文件」与「看目录」（2026-10-14）。
 *
 * 这两条补的是**动手之前先看清楚**这一步。没有它们，agent 只能
 * 一个文件一个文件地 `read_file` 试，几轮就把上下文烧光。
 *
 * 钉的重点：
 *   · 结果里必须带**路径与行号**（模型下一步要拿它去 read_file / edit_file）；
 *   · `include` 只筛文件名、`literal` 关掉正则语义；
 *   · `.git` / `node_modules` 这类**不进**，并且在结果里如实数出来；
 *   · 二进制与超大文件跳过（不是"搜不到"，是"不搜"）；
 *   · 上限是 100（opencode 同值），超了要**说明**截断了。
 */
let ROOT = "";

beforeAll(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "searchtool-"));
  const w = path.join(ROOT, "work");
  fs.mkdirSync(path.join(w, "src"), { recursive: true });
  fs.mkdirSync(path.join(w, "node_modules", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(w, ".git"), { recursive: true });
  fs.writeFileSync(path.join(w, "README.md"), "# 项目说明\n\n这里提到 星辰 一次\n", "utf8");
  fs.writeFileSync(path.join(w, "src", "a.ts"), "const x = 1;\n// 星辰 常量\nfunction 星辰() {}\n", "utf8");
  fs.writeFileSync(path.join(w, "src", "b.md"), "无关内容\n", "utf8");
  fs.writeFileSync(path.join(w, "node_modules", "pkg", "index.js"), "// 星辰 不该被搜到\n", "utf8");
  fs.writeFileSync(path.join(w, ".git", "config"), "星辰 也不该被搜到\n", "utf8");
  fs.writeFileSync(path.join(w, "pattern.txt"), "a.b( 这个字符串当正则是特殊字符\n", "utf8");
  fs.writeFileSync(path.join(w, "二进制.bin"), Buffer.from([0x41, 0x00, 0x42, 0x43]));
  fs.writeFileSync(path.join(w, "很多行.txt"), Array.from({ length: 400 }, (_, i) => `命中行-${i}`).join("\n"), "utf8");
});

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const work = () => path.join(ROOT, "work");
const dirs = () => [work()];

describe("找文件（按内容）", () => {
  it("命中带**路径与行号**（模型要拿它去下一步）", async () => {
    const r = await searchFilesForModel({ pattern: "星辰" }, dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const all = r.matches.join("\n");
    expect(all).toContain("README.md:3:");
    expect(all).toContain("src/a.ts:2:");
    expect(all).toContain("src/a.ts:3:");
  });

  it("⭐ `.git` / `node_modules` 不进（进去就是几十万行，纯烧上下文）", async () => {
    const r = await searchFilesForModel({ pattern: "星辰" }, dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches.join("\n")).not.toContain("node_modules");
    expect(r.matches.join("\n")).not.toContain(".git");
    expect(r.skippedDirs).toBeGreaterThanOrEqual(2);
  });

  it("include 只筛文件名（*.ts 不搜 .md）", async () => {
    const r = await searchFilesForModel({ pattern: "星辰", include: "*.ts" }, dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches.length).toBe(2);
    expect(r.matches.every((m) => m.includes("a.ts"))).toBe(true);
  });

  it("literal 关掉正则语义：同一个 a.b( 当正则是**错的**、当文本才找得到", async () => {
    /* 未闭合的分组 → 如实报「正则写错了」，而不是硬当成文本（那会掩盖模型的写法错误） */
    const asRegex = await searchFilesForModel({ pattern: "a.b(" }, dirs());
    expect(asRegex.ok).toBe(false);
    if (asRegex.ok) return;
    expect(asRegex.error).toContain("正则");

    const asLiteral = await searchFilesForModel({ pattern: "a.b(", literal: true }, dirs());
    expect(asLiteral.ok).toBe(true);
    if (!asLiteral.ok) return;
    expect(asLiteral.matches.length).toBe(1);
    expect(asLiteral.matches[0]).toContain("pattern.txt");
  });

  it("上限默认 100，超了**明说截断了**（不悄悄少给）", async () => {
    expect(SEARCH_DEFAULT_LIMIT).toBe(100);
    const r = await searchFilesForModel({ pattern: "命中行" }, dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches.length).toBe(100);
    expect(r.truncated).toBe(true);
  });

  it("二进制文件跳过（不是搜不到，是不搜）", async () => {
    const r = await searchFilesForModel({ pattern: "ABC", literal: true }, dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches).toEqual([]);
  });

  it("搜不到就是空表（调用方再补一句「一个都没有」）", async () => {
    const r = await searchFilesForModel({ pattern: "这个词一定不存在zzz" }, dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches).toEqual([]);
    expect(nothingFoundNote("这一搜")).toContain("一个都没有");
  });

  it("拒绝：空 pattern / 正则写错 / 目录越界", async () => {
    const empty = await searchFilesForModel({ pattern: "" }, dirs());
    expect(empty.ok).toBe(false);
    const badRe = await searchFilesForModel({ pattern: "([" }, dirs());
    expect(badRe.ok).toBe(false);
    if (badRe.ok) return;
    expect(badRe.error).toContain("正则");
    const outside = await searchFilesForModel({ pattern: "x", path: os.tmpdir() }, dirs());
    expect(outside.ok).toBe(false);
  });
});

describe("看目录", () => {
  it("目录在前、带类型标记与大小；深度默认 2", async () => {
    const r = await listDirForModel({}, dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = r.entries.join("\n");
    expect(text).toContain("d  src/");
    expect(text).toContain("f  README.md (");
    /* 默认深度 2：src 下面那一层看得见 */
    expect(text).toContain("f  a.ts (");
    expect(LIST_DIR_MAX_DEPTH).toBe(4);
  });

  it("⭐ 同一批目录：`.git` / `node_modules` 不看", async () => {
    const r = await listDirForModel({}, dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = r.entries.join("\n");
    expect(text).not.toContain("node_modules");
    expect(text).not.toContain(".git");
  });

  it("pattern 按名字过滤（只看 md）", async () => {
    const r = await listDirForModel({ pattern: "*.md" }, dirs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = r.entries.join("\n");
    expect(text).toContain("README.md");
    expect(text).not.toContain("a.ts");
    /* 目录行仍然在（过滤的是文件，不是结构） */
    expect(text).toContain("d  src/");
  });

  it("越界 → 拒绝", async () => {
    const r = await listDirForModel({ path: os.tmpdir() }, dirs());
    expect(r.ok).toBe(false);
  });
});

describe("两句话（留痕与回给模型共用）", () => {
  it("找文件说清命中几条、看了几个文件", () => {
    expect(describeSearchResult({ ok: true, matches: ["a:1: x"], scanned: 3, skippedDirs: 1, truncated: false }, "星辰")).toContain("命中 1 条");
  });

  it("列目录说清几条，截断了要标出来", () => {
    expect(describeListDirResult({ ok: true, entries: ["d  src/"], truncated: false }, "work")).toContain("1 条");
    expect(describeListDirResult({ ok: true, entries: ["x"], truncated: true }, "work")).toContain("截断");
  });

  it("失败时带上原因", () => {
    expect(describeSearchResult({ ok: false, error: "不在授权范围内" }, "x")).toContain("不在授权范围内");
    expect(describeListDirResult({ ok: false, error: "不在授权范围内" }, "x")).toContain("不在授权范围内");
  });
});
