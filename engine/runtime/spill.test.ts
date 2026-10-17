import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFileSpillStore, insideSpillDir, safeSpillName } from "../adapters/spillStore";
import type { SpillPort } from "../ports/spill";
import {
  SPILL_INLINE_CHARS,
  SPILL_PREVIEW_LINES,
  SPILL_TTL_DAYS,
  applySpill,
  humanBytes,
  lineCountOf,
  previewLines,
  resultPolicyFor,
  shouldSpill,
  spillNote,
} from "./spill";

/**
 * 工具结果落盘（U02）。
 *
 * 挡的是审计点名的"截断即丢"：50k 行日志看完前 8000 字就开始编。
 * 现在超限结果写进会话私有目录、回注路径，`read_file` 能按行回读。
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-spill-"));
  dirs.push(dir);
  return dir;
}

/** 内存版落盘端口（不下盘也能测策略）。 */
function memorySpill(): SpillPort & { written: { toolCallId: string; text: string }[] } {
  const written: { toolCallId: string; text: string }[] = [];
  return {
    dir: "/virtual/tool-results",
    written,
    async write({ toolCallId, text }) {
      written.push({ toolCallId, text });
      return { path: `/virtual/tool-results/${toolCallId}.txt`, bytes: Buffer.byteLength(text, "utf8"), lines: text.split("\n").length };
    },
  };
}

describe("策略（resultPolicyFor）", () => {
  it("读/搜/列目录留头部，跑命令留尾部，其余不落盘", () => {
    expect(resultPolicyFor("read_file")).toBe("spill");
    expect(resultPolicyFor("search_files")).toBe("spill");
    expect(resultPolicyFor("list_dir")).toBe("spill");
    expect(resultPolicyFor("list_files")).toBe("spill");
    expect(resultPolicyFor("run_command")).toBe("tail");
    expect(resultPolicyFor("write_file")).toBe("inline");
    expect(resultPolicyFor("edit_file")).toBe("inline");
    expect(resultPolicyFor("memory_save")).toBe("inline");
  });
});

describe("阈值（shouldSpill）", () => {
  it("小于 8k 字符且不到 2000 行 → 不落盘", () => {
    expect(shouldSpill("x".repeat(SPILL_INLINE_CHARS))).toBe(false);
    expect(shouldSpill("a\n".repeat(100))).toBe(false);
  });

  it("⭐ 超过 8k 字符 → 落盘", () => {
    expect(shouldSpill("x".repeat(SPILL_INLINE_CHARS + 1))).toBe(true);
  });

  it("⭐ 超过 2000 行 → 落盘（即使字符数不多）", () => {
    expect(shouldSpill("a\n".repeat(2_001))).toBe(true);
  });

  it("行数口径：末尾没有换行也算一行", () => {
    expect(lineCountOf("")).toBe(0);
    expect(lineCountOf("a")).toBe(1);
    expect(lineCountOf("a\nb")).toBe(2);
    expect(lineCountOf("a\n")).toBe(2);
  });
});

describe("预览与回注", () => {
  const lines = Array.from({ length: 5_000 }, (_, i) => `line-${i + 1}`);

  it("spill（读/搜）：留**开头** 200 行", () => {
    const got = previewLines(lines, "spill");
    expect(got).toHaveLength(SPILL_PREVIEW_LINES);
    expect(got[0]).toBe("line-1");
    expect(got.at(-1)).toBe(`line-${SPILL_PREVIEW_LINES}`);
  });

  it("tail（命令）：留**末尾** 200 行（结论在最后）", () => {
    const got = previewLines(lines, "tail");
    expect(got.at(-1)).toBe("line-5000");
    expect(got[0]).toBe(`line-${5_000 - SPILL_PREVIEW_LINES + 1}`);
  });

  it("行数不够时原样返回（不补空行）", () => {
    expect(previewLines(["a", "b"], "spill")).toEqual(["a", "b"]);
  });

  it("⭐ 回注里三件事都在：总行数、哪个区间、完整路径", () => {
    const note = spillNote({
      policy: "tail",
      toolName: "run_command",
      totalLines: 50_000,
      shownLines: 2_000,
      path: "C:/data/tool-results/call_1.txt",
      bytes: 1_200_000,
    });
    expect(note).toContain("50,000");
    expect(note).toContain("最后 2,000 行");
    expect(note).toContain("C:/data/tool-results/call_1.txt");
    expect(note).toContain("1.1 MB");
    expect(note).toContain("read_file");
  });

  it("大小口径可复核", () => {
    expect(humanBytes(12)).toBe("12 B");
    expect(humanBytes(2048)).toBe("2.0 KB");
    expect(humanBytes(1024 * 1024)).toBe("1.0 MB");
  });
});

describe("applySpill", () => {
  it("小结果原样返回（同一个对象引用：不为不需要的事复制一遍）", async () => {
    const output = { ok: true, text: "short", count: 1 };
    const got = await applySpill("list_dir", output, memorySpill(), "c1");
    expect(got).toBe(output);
  });

  it("⭐ 大结果落盘：返回预览 + 路径 + 摘要，全文进了落盘端口", async () => {
    const spill = memorySpill();
    const text = Array.from({ length: 3_000 }, (_, i) => `row ${i + 1}`).join("\n");
    const got = (await applySpill("list_dir", { ok: true, text }, spill, "call_9")) as Record<string, unknown>;

    expect(spill.written).toHaveLength(1);
    expect(spill.written[0]?.text).toBe(text);
    expect(got.truncated).toBe(true);
    expect(String(got.text)).toContain("row 1");
    expect(String(got.text)).not.toContain("row 3000");
    expect(String(got.text)).toContain("/virtual/tool-results/call_9.txt");
    expect(got.spillPath).toBe("/virtual/tool-results/call_9.txt");
    expect(got.spillLines).toBe(3_000);
  });

  it("run_command 留尾部（结论在最后几行）", async () => {
    const text = Array.from({ length: 3_000 }, (_, i) => `out ${i + 1}`).join("\n");
    const got = (await applySpill("run_command", { ok: true, text, exitCode: 0 }, memorySpill(), "c2")) as Record<
      string,
      unknown
    >;
    expect(String(got.text)).toContain("out 3000");
    expect(String(got.text)).not.toContain("out 1\n");
    expect(got.exitCode).toBe(0);
  });

  it("结构化的写/改结果不落盘（本来就不大）", async () => {
    const spill = memorySpill();
    const output = { ok: true, text: "x".repeat(20_000), path: "a.txt" };
    const got = await applySpill("write_file", output, spill, "c3");
    expect(got).toBe(output);
    expect(spill.written).toHaveLength(0);
  });

  it("⭐ 落盘失败要**说出来**（不许说「完整结果在 X」而那个文件不存在）", async () => {
    const broken: SpillPort = {
      dir: "/broken",
      async write() {
        throw new Error("磁盘满了");
      },
    };
    const got = (await applySpill("read_file", { ok: true, text: "y".repeat(9_000) }, broken, "c4")) as Record<
      string,
      unknown
    >;
    expect(String(got.text)).toContain("落盘失败");
    expect(String(got.text)).toContain("磁盘满了");
    expect(String(got.text)).not.toContain("完整结果：");
    expect(got.spillPath).toBeNull();
  });

  it("已经是落盘来的结果不再落一次（否则读一次就多一个文件）", async () => {
    const spill = memorySpill();
    const output = { ok: true, text: "z".repeat(20_000), spillPath: "/virtual/old.txt" };
    const got = await applySpill("read_file", output, spill, "c5");
    expect(got).toBe(output);
    expect(spill.written).toHaveLength(0);
  });

  it("不给落盘端口 = 不落盘（最小嵌入面行为不变）", async () => {
    const output = { ok: true, text: "z".repeat(20_000) };
    expect(await applySpill("read_file", output, undefined, "c6")).toBe(output);
  });
});

describe("文件实现（createFileSpillStore）", () => {
  it("写进 <dataDir>/tool-results，名字只由 toolCallId 决定（不可信输入洗过）", async () => {
    const dataDir = tempDir();
    const store = createFileSpillStore(dataDir);
    const got = await store.write({ toolCallId: "../../evil name", toolName: "run_command", text: "hi" });
    expect(got.path.startsWith(path.join(dataDir, "tool-results"))).toBe(true);
    expect(path.basename(got.path)).toBe(safeSpillName("../../evil name"));
    expect(fs.readFileSync(got.path, "utf8")).toContain("hi");
    expect(got.bytes).toBe(2);
  });

  it("⭐ 超过 TTL 的旧文件在下次写入时被清掉", async () => {
    const dataDir = tempDir();
    const store = createFileSpillStore(dataDir);
    const first = await store.write({ toolCallId: "old", toolName: "read_file", text: "old" });
    const old = new Date(Date.now() - (SPILL_TTL_DAYS + 1) * 86_400_000);
    fs.utimesSync(first.path, old, old);
    await store.write({ toolCallId: "new", toolName: "read_file", text: "new" });
    expect(fs.existsSync(first.path)).toBe(false);
    expect(fs.existsSync(path.join(store.dir, "new.txt"))).toBe(true);
  });

  it("写入前会建目录（第一次用不要求目录已存在）", async () => {
    const dataDir = path.join(tempDir(), "nested", "deeper");
    const store = createFileSpillStore(dataDir);
    await store.write({ toolCallId: "x", toolName: "read_file", text: "ok" });
    expect(fs.existsSync(path.join(store.dir, "x.txt"))).toBe(true);
  });
});

describe("回读边界（insideSpillDir）", () => {
  it("目录内放行，`..` 逃逸拒绝", () => {
    const dir = path.join(tempDir(), "tool-results");
    fs.mkdirSync(dir, { recursive: true });
    const inside = path.join(dir, "a.txt");
    fs.writeFileSync(inside, "x", "utf8");
    expect(insideSpillDir(inside, dir)).toBeTruthy();
    expect(insideSpillDir(path.join(dir, "..", "..", "secret.txt"), dir)).toBeNull();
  });
});
