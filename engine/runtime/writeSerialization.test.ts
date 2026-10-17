import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCliExecutor } from "../../hosts/cli/tools";
import { buildToolSet, createToolRegistry } from "./registry";

/**
 * **同文件并发写不丢更新**（U05，2026-10-18 的验收用例）。
 *
 * 缺陷形状（与审计 P42 同源，只是这次长在文件上）：
 * 模型在同一轮里连发两条对**同一个文件**的改动，两边都读到旧内容，
 * 后落盘的把先落盘的整份盖掉 —— 丢一处改动，**而且两条都报成功**。
 *
 * 现在的口径：按目标路径串行。第二条在第一条落盘之后才读文件，
 * 于是它的 `oldText` 已经不存在 —— 它会**如实失败**（"没找到这段"），
 * 而不是静默覆盖。判据因此是"恰好一条成功、一条失败，且最终内容 = 成功那条"。
 */

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-writeserial-"));
  roots.push(dir);
  return dir;
}

function makeTool(dir: string) {
  const executor = createCliExecutor({ dirs: [dir], makeTools: () => ({}) });
  const tools = buildToolSet({
    registry: createToolRegistry({ include: ["edit_file"] }),
    mode: "全部允许",
    executor,
    ctx: { mode: "全部允许", provider: "p" },
  });
  return tools.edit_file!.execute as (v: unknown) => Promise<unknown>;
}

describe("同文件并发写（U05）", () => {
  it("⭐ 两条并发 edit 不会双双成功后互相覆盖：一条成功、一条如实失败", async () => {
    const dir = tempDir();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "x = 1\n", "utf8");
    const exec = makeTool(dir);

    const first = exec({ path: file, oldText: "x = 1", newText: "x = 2" });
    const second = exec({ path: file, oldText: "x = 1", newText: "y = 1" });
    const [a, b] = await Promise.allSettled([first, second]);

    /* 第一条（先进队列）成功；第二条看到的是改过的文件，oldText 不在了 */
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");

    /* 最终内容就是成功那条改出来的 —— 没有被后一条整份盖回去 */
    expect(fs.readFileSync(file, "utf8")).toBe("x = 2\n");
  });

  it("不同文件可以并行（按路径串行没有退化成全局串行）", async () => {
    const dir = tempDir();
    const one = path.join(dir, "one.txt");
    const two = path.join(dir, "two.txt");
    fs.writeFileSync(one, "a", "utf8");
    fs.writeFileSync(two, "b", "utf8");
    const exec = makeTool(dir);

    const [x, y] = await Promise.all([
      exec({ path: one, oldText: "a", newText: "A" }),
      exec({ path: two, oldText: "b", newText: "B" }),
    ]);
    expect(x).toBeTruthy();
    expect(y).toBeTruthy();
    expect(fs.readFileSync(one, "utf8")).toBe("A");
    expect(fs.readFileSync(two, "utf8")).toBe("B");
  });
});
