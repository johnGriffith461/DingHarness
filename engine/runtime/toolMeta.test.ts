import { describe, expect, it } from "vitest";

import { AGENT_TOOLS, RUN_COMMAND_TOOL, READ_FILE_TOOL, WRITE_FILE_TOOL } from "../../shared/agentTools";
import { policyOf } from "../core/policy";
import { buildToolSet, builtinToolEntries, completeToolEntry, createToolRegistry } from "./registry";

/**
 * D2：工具元数据。
 * 两条判据：`readOnly` 与权限表同源；`exclusive` 的调用真的排队。
 */

describe("内置工具的元数据", () => {
  it("每个内置工具都有完整元数据，readOnly 与权限表一致", () => {
    const entries = builtinToolEntries();
    expect(entries.length).toBe(AGENT_TOOLS.length);
    for (const entry of entries) {
      expect(typeof entry.readOnly, `${entry.name} 没有 readOnly`).toBe("boolean");
      expect(entry.readOnly).toBe(policyOf(entry.name).kind === "read");
      expect(["safe", "exclusive"]).toContain(entry.concurrency);
      expect(["inline", "spill", "tail"]).toContain(entry.resultPolicy);
    }
  });

  it("写文件是破坏性 + 串行；读文件是安全并发", () => {
    const byName = new Map(builtinToolEntries().map((e) => [e.name, e]));
    expect(byName.get(WRITE_FILE_TOOL)).toMatchObject({ destructive: true, concurrency: "exclusive", readOnly: false });
    expect(byName.get(READ_FILE_TOOL)).toMatchObject({ destructive: false, concurrency: "safe", readOnly: true });
    expect(byName.get(RUN_COMMAND_TOOL)).toMatchObject({ destructive: true, concurrency: "exclusive", resultPolicy: "tail", timeoutMs: 120_000 });
  });
});

describe("外部来源的默认值", () => {
  it("MCP 不给元数据 → 保守默认（不可并行、需按写处理）", () => {
    const registry = createToolRegistry({
      extra: [{ name: "mcp__srv__do", source: "mcp", description: "x", inputSchema: {} as never }],
    });
    expect(registry.get("mcp__srv__do")).toMatchObject({
      readOnly: false,
      destructive: false,
      concurrency: "exclusive",
      resultPolicy: "inline",
    });
  });

  it("MCP 声明 readOnlyHint → readOnly:true（且并发才可能安全）", () => {
    const entry = completeToolEntry({
      name: "mcp__srv__list",
      source: "mcp",
      description: "x",
      inputSchema: {} as never,
      readOnlyHint: true,
      concurrency: "safe",
    });
    expect(entry.readOnly).toBe(true);
    expect(entry.concurrency).toBe("safe");
  });

  it("只读但没声明并发 → 仍是 exclusive（不擅自并行）", () => {
    const entry = completeToolEntry({
      name: "mcp__srv__list",
      source: "mcp",
      description: "x",
      inputSchema: {} as never,
      readOnlyHint: true,
    });
    expect(entry.concurrency).toBe("exclusive");
  });
});

describe("串行队列", () => {
  it("⭐ 同一 exclusive 工具并发调用会排队（不重叠）", async () => {
    const events: string[] = [];
    let running = 0;
    const executor = {
      run: async (name: string) => {
        running += 1;
        events.push(`${name}:start:${running}`);
        await new Promise((r) => setTimeout(r, 20));
        events.push(`${name}:end:${running}`);
        running -= 1;
        return { ok: true as const, output: { done: true } };
      },
    };
    const set = buildToolSet({
      registry: createToolRegistry({}),
      mode: "全部允许",
      executor,
      ctx: { mode: "全部允许", provider: "p", model: "m" },
    });
    const tool = set[RUN_COMMAND_TOOL] as unknown as { execute: (input: unknown, opts: { toolCallId: string }) => Promise<unknown> };

    await Promise.all([
      tool.execute({ command: "a" }, { toolCallId: "c1" }),
      tool.execute({ command: "b" }, { toolCallId: "c2" }),
    ]);

    expect(events).toEqual(["run_command:start:1", "run_command:end:1", "run_command:start:1", "run_command:end:1"]);
  });

  it("readOnly safe 工具允许重叠", async () => {
    let running = 0;
    let max = 0;
    const executor = {
      run: async () => {
        running += 1;
        max = Math.max(max, running);
        await new Promise((r) => setTimeout(r, 20));
        running -= 1;
        return { ok: true as const, output: { text: "x" } };
      },
    };
    const set = buildToolSet({
      registry: createToolRegistry({}),
      mode: "全部允许",
      executor,
      ctx: { mode: "全部允许", provider: "p", model: "m" },
    });
    const tool = set[READ_FILE_TOOL] as unknown as { execute: (input: unknown, opts: { toolCallId: string }) => Promise<unknown> };

    await Promise.all([
      tool.execute({ path: "a" }, { toolCallId: "r1" }),
      tool.execute({ path: "b" }, { toolCallId: "r2" }),
    ]);
    expect(max).toBe(2);
  });
});
