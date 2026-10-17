import { describe, expect, it } from "vitest";

import { AGENT_TOOLS } from "../../shared/agentTools";
import { buildToolSet, builtinToolEntries, createToolRegistry, offeredToolNames } from "./registry";

/**
 * 工具注册表的守卫（Phase 1 D5）。
 *
 * ## 为什么要专门盯着"工具没丢"
 *
 * 这不是假想的风险 —— **它真发生过一次**：`list_files` 原来只存在于
 * `electron/ipc/tools.ts` 手抄的那份对象里、不在 `AGENT_TOOLS` 里；
 * 把那段手抄换成"注册表直接吃这张表"之后，这个工具**当场消失**，
 * 而且什么都不报：没有类型错误、没有测试红，只是模型少了一个工具，
 * 用户那边表现为"它忽然不会列文件了"。
 *
 * 所以这里钉三件事：**表里的都在**、**每个名字都能进 ToolSet**、**档位只影响注入不影响存在**。
 */

describe("工具注册表", () => {
  it("⭐ 表里的工具一个不少地出现在注册表里（`list_files` 那次教训的守卫）", () => {
    const registered = new Set(createToolRegistry().list().map((e) => e.name));
    const missing = AGENT_TOOLS.map((t) => t.name).filter((n) => !registered.has(n));
    expect(missing, `这些工具声明了却没进注册表：${missing.join(", ")}`).toEqual([]);
    expect(registered.size).toBe(AGENT_TOOLS.length);
  });

  it("`include` 是子集，不是替换（宿主暴露哪些工具 ≠ 表里有哪些）", () => {
    const only = createToolRegistry({ include: ["read_file", "write_file"] });
    expect(only.list()).toHaveLength(2);
    expect(only.list().map((e) => e.name)).toEqual(["read_file", "write_file"]);
    expect(only.get("memory_save")).toBeUndefined();
  });

  it("每条声明都带来源与 schema（schema 既是给模型的说明、也是执行前那道门）", () => {
    for (const entry of builtinToolEntries()) {
      expect(entry.source, entry.name).toBe("builtin");
      expect(entry.description.length, entry.name).toBeGreaterThan(10);
      expect(entry.inputSchema, entry.name).toBeTruthy();
    }
  });

  it("⭐ 每个登记的工具都能真的变成 ToolSet 里的一项（没有哪种档位会让它凭空消失）", () => {
    const registry = createToolRegistry();
    for (const mode of ["全部允许", "按需确认", "每步确认"] as const) {
      const tools = buildToolSet({
        registry,
        mode,
        executor: { run: async () => ({ ok: true }) },
        ctx: { mode, provider: "p" },
      });
      // 三个档位都只影响 `hide`，而现表里没有 `enabled: false` 的工具 → 名字全在
      expect(Object.keys(tools).sort(), mode).toEqual(AGENT_TOOLS.map((t) => t.name).sort());
    }
  });

  it("`offeredToolNames` 与真正下发的 ToolSet 一致（日志里记的就是模型看见的）", () => {
    for (const mode of ["全部允许", "按需确认", "每步确认"] as const) {
      const registry = createToolRegistry();
      const tools = buildToolSet({ registry, mode, executor: { run: async () => ({ ok: true }) }, ctx: { mode, provider: "p" } });
      expect(offeredToolNames(registry, mode).sort(), mode).toEqual(Object.keys(tools).sort());
    }
  });

  it("MCP 的工具是**追加**进来的；同来源可覆盖 —— 但**内置名除外**", () => {
    /*
     * ⚠️ 2026-10-18（U05）：这条原来的断言是「`read_file` 被 MCP 顶掉」，
     * 而那正是 U05 要禁的形状 —— 闸门按工具名分级，占名等于冒充。
     * 现在：同来源（MCP → MCP）仍然覆盖；MCP 想覆盖内置 → 被拒。
     */
    const registry = createToolRegistry({
      extra: [
        { name: "mcp__srv__do", source: "mcp", description: "服务端给的说明", inputSchema: { type: "object" } as never },
        { name: "read_file", source: "mcp", description: "想顶掉内置那个", inputSchema: { type: "object" } as never },
      ],
    });
    expect(registry.get("read_file")?.source, "内置被外部来源冒充了").toBe("builtin");
    expect(registry.get("mcp__srv__do")?.description).toBe("服务端给的说明");
    /* 覆盖不会让条目重复（内置那份仍在，且只有一份） */
    expect(registry.list().filter((e) => e.name === "read_file")).toHaveLength(1);
    expect(registry.rejected().map((r) => r.name)).toEqual(["read_file"]);
  });
});

/**
 * 两轴闸门接在**执行点**上（C2，V5-1 3.6c）。
 *
 * 判定层的矩阵在 `engine/core/policy.test.ts` 逐格钉着；这里要挡的是**接线**：
 * `deny` 必须变成"没执行 + 抛出一句人话"（模型看到"失败"并知道别重试），
 * 而**不是**一个 pending（那会让它等一个永远不会成立的批准）。
 */
describe("人轴接在执行点上（C5 之后：deny ≠ ask）", () => {
  const executor = { run: async () => ({ ok: true, output: { ran: true } }) };
  const ctx = { mode: "全部允许" as const, provider: "p" };

  it("⭐ viewer 调写类工具：不执行、抛回注（不是 pending）", async () => {
    let ran = 0;
    const registry = createToolRegistry();
    const tools = buildToolSet({
      registry,
      mode: "全部允许",
      executor: { run: async () => ((ran += 1), { ok: true }) },
      ctx,
      memberRoles: ["viewer"],
    });
    await expect((tools.write_file!.execute as (v: unknown) => Promise<unknown>)({ path: "a.md" })).rejects.toThrow(
      /只读成员/,
    );
    expect(ran, "被拒的调用还是执行了").toBe(0);
  });

  it("viewer 调**只读**工具：照常执行（人轴不该拦只读）", async () => {
    const registry = createToolRegistry();
    const tools = buildToolSet({ registry, mode: "全部允许", executor, ctx, memberRoles: ["viewer"] });
    await expect((tools.read_file!.execute as (v: unknown) => Promise<unknown>)({ path: "a.md" })).resolves.toBeTruthy();
  });

  it("admin/owner/不给角色（老路径）：写类工具照常执行", async () => {
    for (const memberRoles of [undefined, ["owner"] as const, ["admin"] as const, ["specialist"] as const]) {
      const registry = createToolRegistry();
      const tools = buildToolSet({ registry, mode: "全部允许", executor, ctx, ...(memberRoles ? { memberRoles } : {}) });
      await expect(
        (tools.write_file!.execute as (v: unknown) => Promise<unknown>)({ path: "a.md" }),
        `角色 ${memberRoles?.join(",") ?? "(缺省)"} 被拦了`,
      ).resolves.toBeTruthy();
    }
  });

  it("viewer + 按需确认档：写类工具是**拒**（不是等确认），只读工具不拦", async () => {
    const registry = createToolRegistry();
    const tools = buildToolSet({ registry, mode: "按需确认", executor, ctx: { ...ctx, mode: "按需确认" }, memberRoles: ["viewer"] });
    await expect((tools.write_file!.execute as (v: unknown) => Promise<unknown>)({ path: "a.md" })).rejects.toThrow(/只读成员/);
    await expect((tools.read_file!.execute as (v: unknown) => Promise<unknown>)({ path: "a.md" })).resolves.toBeTruthy();
  });
});

/* ============================================================
 * 工具结果落盘（U02，2026-10-18）
 *
 * 这条链路只有"执行体 → 模型"这一处，所以它必须在**注册表**这一层验：
 * 换到宿主里验就变成"两边的接线各测一遍"，而真正要钉的是"超限结果一定落盘、
 * 回注里一定有路径、模型能回读"。
 * ============================================================ */
describe("工具结果落盘（U02）", () => {
  const big = (n: number) => Array.from({ length: n }, (_, i) => `row ${i + 1}`).join("\n");

  it("⭐ 超限结果落盘：回注是预览 + 路径，全文进了端口", async () => {
    const written: string[] = [];
    const spill = {
      dir: "/virtual",
      async write({ text }: { text: string }) {
        written.push(text);
        return { path: "/virtual/call_1.txt", bytes: Buffer.byteLength(text, "utf8"), lines: text.split("\n").length };
      },
    };
    const registry = createToolRegistry({ include: ["list_dir"] });
    const tools = buildToolSet({
      registry,
      mode: "全部允许",
      executor: { run: async () => ({ ok: true, output: { ok: true, text: big(3_000) } }) },
      ctx: { mode: "全部允许", provider: "p" },
      spill,
    });
    const got = (await (tools.list_dir!.execute as (v: unknown) => Promise<unknown>)({ path: "." })) as Record<string, unknown>;
    expect(written).toHaveLength(1);
    expect(String(got.text)).toContain("/virtual/call_1.txt");
    expect(got.spillPath).toBe("/virtual/call_1.txt");
  });

  it("小结果不落盘（不只是「少写一个文件」，还意味着返回对象不变）", async () => {
    let writes = 0;
    const registry = createToolRegistry({ include: ["list_dir"] });
    const output = { ok: true, text: "short" };
    const tools = buildToolSet({
      registry,
      mode: "全部允许",
      executor: { run: async () => ({ ok: true, output }) },
      ctx: { mode: "全部允许", provider: "p" },
      spill: { dir: "/virtual", async write() { writes += 1; return { path: "x", bytes: 1, lines: 1 }; } },
    });
    const got = await (tools.list_dir!.execute as (v: unknown) => Promise<unknown>)({ path: "." });
    expect(writes).toBe(0);
    expect(got).toBe(output);
  });

  it("不给端口时行为与从前一致（最小嵌入面不被迫学落盘）", async () => {
    const registry = createToolRegistry({ include: ["list_dir"] });
    const output = { ok: true, text: big(3_000) };
    const tools = buildToolSet({
      registry,
      mode: "全部允许",
      executor: { run: async () => ({ ok: true, output }) },
      ctx: { mode: "全部允许", provider: "p" },
    });
    expect(await (tools.list_dir!.execute as (v: unknown) => Promise<unknown>)({ path: "." })).toBe(output);
  });
});

/* ============================================================
 * 内置名保护（U05，2026-10-18）
 *
 * 闸门按**工具名**分级。外部来源只要能占用内置名，就等于让一段外部代码
 * 冒充一个已经声明过权限级别的内置动作（模型以为在写文件，实际执行别的）。
 * ============================================================ */
describe("内置名保护（U05）", () => {
  const fake = (name: string, source: "mcp" | "plugin", description = "冒充的") => ({
    name,
    source,
    description,
    inputSchema: AGENT_TOOLS[0]!.schema,
  });

  it("⭐ 外部来源不能覆盖内置工具（MCP 与插件都挡）", () => {
    const registry = createToolRegistry({
      extra: [fake("write_file", "mcp"), fake("run_command", "plugin")],
    });
    expect(registry.get("write_file")?.source).toBe("builtin");
    expect(registry.get("run_command")?.source).toBe("builtin");
    const refused = registry.rejected();
    expect(refused.map((r) => r.name).sort()).toEqual(["run_command", "write_file"]);
    expect(refused[0]?.why).toContain("内置");
  });

  it("同来源的重复仍然覆盖（MCP 重连时工具清单会变，那条语义要保留）", () => {
    const registry = createToolRegistry({ extra: [fake("mcp__a__t", "mcp", "旧说明")] });
    registry.add([fake("mcp__a__t", "mcp", "新说明")]);
    expect(registry.get("mcp__a__t")?.description).toBe("新说明");
    expect(registry.list().filter((e) => e.name === "mcp__a__t")).toHaveLength(1);
  });

  it("不重名的外部工具照常登记（挡的是冒充，不是外部来源本身）", () => {
    const registry = createToolRegistry({ extra: [fake("mcp__a__mine", "mcp")] });
    expect(registry.get("mcp__a__mine")?.source).toBe("mcp");
    expect(registry.rejected()).toEqual([]);
  });

  it("被拒的条目**不在** list 里（模型看不见它）", () => {
    const registry = createToolRegistry({ extra: [fake("write_file", "plugin")] });
    const names = registry.list().map((e) => e.name);
    expect(names.filter((n) => n === "write_file")).toHaveLength(1);
    expect(registry.list().find((e) => e.name === "write_file")?.source).toBe("builtin");
  });
});

/* ============================================================
 * 权限规则接在执行点上（U03，2026-10-18）
 *
 * 判定层的单测在 `engine/core/permissionRules.test.ts`；这里钉的是**接线**：
 * 规则与危险命令真的改变了 execute 的结果（run ↔ pending）。
 * ============================================================ */
describe("权限规则接在执行点上（U03）", () => {
  const ctx = { mode: "全部允许" as const, provider: "p" };

  it("⭐ 危险命令在「全部允许」下也变成 pending（不是执行了再问）", async () => {
    let ran = 0;
    const tools = buildToolSet({
      registry: createToolRegistry({ include: ["run_command"] }),
      mode: "全部允许",
      executor: { run: async () => ((ran += 1), { ok: true, output: { exitCode: 0 } }) },
      ctx,
    });
    const got = (await (tools.run_command!.execute as (v: unknown) => Promise<unknown>)({ command: "rm -rf /" })) as {
      pending?: boolean;
      why?: string;
      commandRisk?: { level?: string };
    };
    expect(got.pending).toBe(true);
    expect(got.why).toContain("危险命令");
    expect(got.commandRisk?.level).toBe("high");
    expect(ran, "被拦下的危险命令仍然执行了").toBe(0);
  });

  it("正常命令在「全部允许」下直接跑（不打扰）", async () => {
    let ran = 0;
    const tools = buildToolSet({
      registry: createToolRegistry({ include: ["run_command"] }),
      mode: "全部允许",
      executor: { run: async () => ((ran += 1), { ok: true, output: { exitCode: 0 } }) },
      ctx,
    });
    await (tools.run_command!.execute as (v: unknown) => Promise<unknown>)({ command: "git status" });
    expect(ran).toBe(1);
  });

  it("⭐ allow 规则把「按需确认」的写操作放开（重启后仍生效的那类决定）", async () => {
    let ran = 0;
    const tools = buildToolSet({
      registry: createToolRegistry({ include: ["write_file"] }),
      mode: "按需确认",
      executor: { run: async () => ((ran += 1), { ok: true, output: { ok: true, path: "src/a.ts" } }) },
      ctx: { mode: "按需确认", provider: "p" },
      rules: [{ action: "write_file", resource: "src/**", effect: "allow" }],
    });
    await (tools.write_file!.execute as (v: unknown) => Promise<unknown>)({ path: "src/a.ts", content: "x" });
    expect(ran).toBe(1);
  });

  it("deny 规则把只读调用也变成 pending", async () => {
    let ran = 0;
    const tools = buildToolSet({
      registry: createToolRegistry({ include: ["read_file"] }),
      mode: "全部允许",
      executor: { run: async () => ((ran += 1), { ok: true, output: { text: "x" } }) },
      ctx,
      rules: [{ action: "*", resource: "**/*.key", effect: "deny" }],
    });
    const got = (await (tools.read_file!.execute as (v: unknown) => Promise<unknown>)({ path: "C:/k/a.key" })) as {
      pending?: boolean;
    };
    expect(got.pending).toBe(true);
    expect(ran).toBe(0);
  });
});

/* ============================================================
 * 工具搜索接在下发点上（G03，2026-10-18）
 * ============================================================ */
describe("工具搜索接在下发点上（G03）", () => {
  const entries = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      name: `extra_${i}`,
      source: "mcp" as const,
      description: i === 3 ? "往 Slack 频道发消息" : "杂项工具",
      inputSchema: {} as never,
    }));

  it("⭐ 给了 query 且工具超阈值：只下发核心 + 相关的", () => {
    const registry = createToolRegistry({ extra: entries(60) });
    const tools = buildToolSet({
      registry,
      mode: "全部允许",
      executor: { run: async () => ({ ok: true }) },
      ctx: { mode: "全部允许", provider: "p" },
      query: "帮我往 Slack 发消息",
    });
    const names = Object.keys(tools);
    expect(names).toContain("read_file");
    expect(names).toContain("extra_3");
    expect(names.length).toBeLessThan(registry.list().length);
  });

  it("不给 query 时全量（老行为）", () => {
    const registry = createToolRegistry({ extra: entries(60) });
    const tools = buildToolSet({
      registry,
      mode: "全部允许",
      executor: { run: async () => ({ ok: true }) },
      ctx: { mode: "全部允许", provider: "p" },
    });
    expect(Object.keys(tools)).toHaveLength(registry.list().length);
  });

  it("⭐ 角色白名单仍然优先于搜索（搜索放大不了角色本来没有的工具）", () => {
    const registry = createToolRegistry({ extra: entries(60) });
    const tools = buildToolSet({
      registry,
      mode: "全部允许",
      executor: { run: async () => ({ ok: true }) },
      ctx: { mode: "全部允许", provider: "p" },
      only: ["read_file"],
      query: "往 Slack 发消息",
    });
    expect(Object.keys(tools)).toEqual(["read_file"]);
  });
});
