import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFileSpillStore } from "../adapters/spillStore";
import { buildToolSet, createToolRegistry } from "./registry";
import { createCliExecutor } from "../../hosts/cli/tools";
import { readFileForModel } from "./tools/readTool";

/**
 * **50k 行日志的端到端**（U02 的验收用例）。
 *
 * 审计的原话是"截断即丢"：模型看完 8000 字就开始编。这条测试走完整条链路 ——
 * 真实文件 → 真实执行体 → 注册表（落盘）→ 模型拿到的预览 → 按行回读落盘文件。
 *
 * 用 `createCliExecutor` 而不是手搓执行体：落盘是否真的接上了宿主，
 * 只有走宿主那份装配才验得到（只测 `applySpill` 会漏掉"执行体根本没把大正文交出来"）。
 */

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-spill-e2e-"));
  roots.push(dir);
  return dir;
}

describe("50k 行日志：截断不丢证据（U02 验收）", () => {
  it("⭐ 读日志 → 只看到前 200 行 + 落盘路径；按行回读能拿到第 49000 行", async () => {
    const work = tempDir();
    const data = tempDir();
    const log = path.join(work, "app.log");
    const lineCount = 50_000;
    fs.writeFileSync(log, Array.from({ length: lineCount }, (_, i) => `[info] line ${i + 1}`).join("\n"), "utf8");

    const spill = createFileSpillStore(data);
    const executor = createCliExecutor({
      dirs: [work],
      extraReadDirs: [spill.dir],
      makeTools: () => ({}),
    });
    const tools = buildToolSet({
      registry: createToolRegistry({ include: ["read_file"] }),
      mode: "全部允许",
      executor,
      ctx: { mode: "全部允许", provider: "p" },
      spill,
    });

    const got = (await (tools.read_file!.execute as (v: unknown) => Promise<unknown>)({ path: log })) as Record<
      string,
      unknown
    >;

    /* ① 模型看到的不是全文，也不是"只剩 8000 字" —— 是 200 行预览 + 去哪找 */
    const text = String(got.text);
    expect(text).toContain("line 1");
    expect(text).not.toContain("line 50000");
    expect(text).toContain("50,000");
    expect(text).toContain("read_file");
    const spillPath = String(got.spillPath);
    expect(fs.existsSync(spillPath)).toBe(true);

    /* ② 落盘文件里是**完整**的 50k 行（证据没丢） */
    const saved = fs.readFileSync(spillPath, "utf8");
    expect(saved).toContain("line 50000");
    expect(saved).toContain("line 1");

    /* ③ 按行回读：第 49000 行起读 5 行 —— 这是"再读全文"的真实路径 */
    const paged = await readFileForModel(spillPath, [work], {
      extraReadDirs: [spill.dir],
      page: { offset: 49_000, limit: 5 },
    });
    expect(paged.ok).toBe(true);
    if (paged.ok) {
      expect(paged.text).toContain("line 49000");
      expect(paged.fromLine).toBe(49_000);
      expect(paged.totalLines).toBeGreaterThanOrEqual(lineCount);
    }
  });

  it("落盘目录之外的路径仍然读不到（额外只读根没有把墙拆了）", async () => {
    const work = tempDir();
    const data = tempDir();
    const spill = createFileSpillStore(data);
    const secret = path.join(tempDir(), "secret.txt");
    fs.writeFileSync(secret, "top secret", "utf8");
    const got = await readFileForModel(secret, [work], { extraReadDirs: [spill.dir] });
    expect(got.ok).toBe(false);
  });
});
