import { describe, expect, it } from "vitest";

import { noopHooks, runHookWithTimeout, type HooksPort } from "../ports/hooks";
import { buildToolSet, createToolRegistry } from "./registry";
import { READ_FILE_TOOL } from "../../shared/agentTools";

/**
 * F5：五类钩子与 tool:before 的决策。
 * 关键判据：`modify` 真的换参数；超时/抛错**一律 deny**（fail-closed）。
 */

function setWith(hooks: HooksPort, executorRun: (name: string, input: unknown) => Promise<unknown>) {
  return buildToolSet({
    registry: createToolRegistry({}),
    mode: "全部允许",
    executor: { run: (name: string, input: unknown) => executorRun(name, input) } as never,
    ctx: { mode: "全部允许", provider: "p", model: "m" },
    hooks,
  });
}

const call = async (set: Record<string, unknown>, input: unknown) => {
  const tool = set[READ_FILE_TOOL] as unknown as { execute: (i: unknown, o: { toolCallId: string }) => Promise<unknown> };
  return await tool.execute(input, { toolCallId: "c1" });
};

describe("tool:before 决策", () => {
  it("⭐ modify 真的换掉参数", async () => {
    let executorInput: unknown;
    const hooks: HooksPort = {
      run: async (hook) =>
        hook === "tool:before" ? { action: "modify", input: { path: "changed.txt" } } : undefined,
    };
    const set = setWith(hooks, async (_name, input) => {
      executorInput = input;
      return { ok: true, output: { text: "x" } };
    });
    await call(set, { path: "original.txt" });
    expect(executorInput).toEqual({ path: "changed.txt" });
  });

  it("⭐ deny 抛错（模型拿到一句人话，不执行）", async () => {
    let ran = false;
    const hooks: HooksPort = {
      run: async (hook) => (hook === "tool:before" ? { action: "deny", reason: "禁止读这个文件" } : undefined),
    };
    const set = setWith(hooks, async () => {
      ran = true;
      return { ok: true, output: {} };
    });
    await expect(call(set, { path: "a" })).rejects.toThrow("禁止读这个文件");
    expect(ran).toBe(false);
  });

  it("⭐ 钩子抛错 → fail-closed（不执行）", async () => {
    let ran = false;
    const hooks: HooksPort = {
      run: async (hook) => {
        if (hook === "tool:before") throw new Error("插件炸了");
        return undefined;
      },
    };
    const set = setWith(hooks, async () => {
      ran = true;
      return { ok: true, output: {} };
    });
    await expect(call(set, { path: "a" })).rejects.toThrow("钩子");
    expect(ran).toBe(false);
  });

  it("allow（默认）照常执行", async () => {
    const set = setWith(noopHooks, async () => ({ ok: true, output: { text: "ok" } }));
    await expect(call(set, { path: "a" })).resolves.toBeTruthy();
  });
});

describe("runHookWithTimeout", () => {
  it("超时返回 ok:false（调用方据此 deny）", async () => {
    const slow: HooksPort = { run: () => new Promise(() => undefined) };
    const got = await runHookWithTimeout(slow, "tool:before", {}, 30);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toContain("超时");
  });

  it("正常返回 ok:true 与原值", async () => {
    const got = await runHookWithTimeout({ run: async () => ({ action: "allow" }) }, "tool:before", {}, 30);
    expect(got).toEqual({ ok: true, value: { action: "allow" } });
  });
});
