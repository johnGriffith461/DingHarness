import { describe, expect, it } from "vitest";

import { buildToolSet, createToolRegistry } from "./registry";
import type { ExecutorContext } from "../ports/executor";

/**
 * A-03：CLI 就地审批（引擎侧端口）。
 *
 * 判据：
 * - 注入 `approve` → 问一次；allow / allow-always 都继续执行；
 * - deny → **抛错**（投影算 ok=false、模型拿到人话），且执行体没被调用；
 * - 不注入 → 仍是 `{ pending: true }`（桌面那条路一字不改）。
 */
function toolsFor(mode: "按需确认", approve?: NonNullable<ExecutorContext["approve"]>, onRun?: () => void) {
  return buildToolSet({
    registry: createToolRegistry(),
    mode,
    executor: {
      run: async () => {
        onRun?.();
        return { ok: true, output: { line: "已写入" } };
      },
    },
    ctx: { mode, provider: "strata", ...(approve ? { approve } : {}) },
  });
}

const writeA = (tools: ReturnType<typeof toolsFor>) =>
  (tools.write_file!.execute as (v: unknown) => Promise<unknown>)({ path: "a.md", content: "x" });

describe("A-03 · 引擎的批准端口", () => {
  it("注入 approve=allow：问到了这次调用，且执行体真的跑了", async () => {
    let ran = 0;
    const asked: Array<{ name: string; input: unknown }> = [];
    const tools = toolsFor("按需确认", async (req) => {
      asked.push({ name: req.name, input: req.input });
      return "allow";
    }, () => (ran += 1));

    const got = (await writeA(tools)) as { line?: string };
    expect(asked).toHaveLength(1);
    expect(asked[0]!.name).toBe("write_file");
    expect(ran).toBe(1);
    expect(got.line).toBe("已写入");
  });

  it("注入 approve=allow-always：同样执行（记账是宿主的事）", async () => {
    let ran = 0;
    const tools = toolsFor("按需确认", async () => "allow-always", () => (ran += 1));
    await writeA(tools);
    expect(ran).toBe(1);
  });

  it("注入 approve=deny：抛错，且执行体没被调用", async () => {
    let ran = 0;
    const tools = toolsFor("按需确认", async () => "deny", () => (ran += 1));
    await expect(writeA(tools)).rejects.toThrow(/用户拒绝/);
    expect(ran, "被拒绝的调用还是执行了").toBe(0);
  });

  it("不注入 approve：仍是 pending（桌面路径不回归）", async () => {
    const tools = toolsFor("按需确认");
    const got = (await writeA(tools)) as { pending?: boolean; notice?: string };
    expect(got.pending).toBe(true);
    expect(got.notice).toContain("还没有执行");
  });
});
