import { tool, type FlexibleSchema, type ToolSet } from "ai";

import {
  AGENT_TOOLS,
  MAX_SUBAGENT_DEPTH,
  SPAWN_AGENT_TOOL,
  toolSpec,
} from "../../shared/agentTools";
import type { ConfirmMode } from "../../shared/ipc";
import { pendingApprovalNotice, toolFailedNotice } from "../core/notices";
import { decide, injectableTools } from "../core/policy";
import type { ExecutorContext, ToolExecutor } from "../ports/executor";

/**
 * **工具注册表**（Phase 1 D5）。
 *
 * ## 它统一了什么
 *
 * 在它之前，"这一轮给模型哪些工具"是由 `electron/ipc/tools.ts` 里一段 300 行的
 * 手写对象字面量决定的：13 个内置工具每个都手抄一遍 `description` / `inputSchema` /
 * `execute`，再加上一段 MCP 的 `for` 循环。于是三件事各自散在三个地方：
 *
 * | 问题 | 原来 | 现在 |
 * |---|---|---|
 * | 有哪些工具 | `AGENT_TOOLS` 声明 + 手抄对象两处 | 注册表一处（内置那份**直接来自 `AGENT_TOOLS`**） |
 * | 该不该注入 | `injectableTools()` 调用一次，散在末尾 | 构建时统一过一遍 |
 * | 被拦下回什么 | `gated()` 包一层，逐个手写 | 同一个执行包装 |
 *
 * ## 三个来源
 *
 * - **builtin**：`shared/agentTools.ts` 的 `AGENT_TOOLS`（schema 与说明的唯一来源）。
 * - **mcp**：连接器（MCP server）在运行时交出来的工具，schema 是服务端给的 JSON Schema。
 * - **plugin**：预留位（Phase 8）。现在没有实现，但**位置在这里** ——
 *   加来源时是"往 `add()` 里塞一批"，不是"再写一段 300 行的字面量"。
 *
 * ## 为什么"隐藏"要在构建时做掉
 *
 * `hide` 的语义是**模型看不到它**（而不是"注入了但会被拒"）：模型看不到就不会在回复里说
 * "我来调用 xxx"然后失败。所以它必须在**构造 ToolSet 时**被剔掉，不能留到执行时判 ——
 * 留到执行时就等于它已经在模型的工具清单里了。
 */

/** 一条工具的来源。 */
export type ToolSource = "builtin" | "mcp" | "plugin";

/** 注册表里的一条。 */
export type ToolEntry = {
  name: string;
  source: ToolSource;
  /** 给模型的说明。 */
  description: string;
  /** 给模型的参数说明 + 执行前校验（zod 或 JSON Schema，`ai` 两种都收）。 */
  inputSchema: FlexibleSchema<unknown>;
};

export type ToolRegistry = {
  /** 全部已注册的条目（顺序即注入顺序）。 */
  list(): ToolEntry[];
  /** 按名取一条。 */
  get(name: string): ToolEntry | undefined;
  /** 登记一批（重复名字会**覆盖**并保留原位置 —— MCP 重连时工具清单会变）。 */
  add(entries: readonly ToolEntry[]): void;
};

/**
 * 内置工具那一批。
 *
 * ⚠️ 它**就是** `AGENT_TOOLS`：这里不再手抄一遍说明与 schema。
 * 手抄的代价实测过 —— `WRITE_FILE_MODEL_CHARS` 那种"说明里一个数、执行体里另一个数"
 * 的错就是这么来的（模型照着说明写、被拒绝，然后开始瞎猜）。
 */
export function builtinToolEntries(): ToolEntry[] {
  return AGENT_TOOLS.map((spec) => ({
    name: spec.name,
    source: "builtin" as const,
    description: spec.description,
    inputSchema: spec.schema as FlexibleSchema<unknown>,
  }));
}

/**
 * 建一个注册表。
 *
 * @param opts.extra 额外的来源（MCP 的工具、Phase 8 的插件工具）
 * @param opts.include 只要内置里的这些（**宿主暴露子集**用：CLI 登记不了"记忆"这种
 *   落到桌面界面 store 上的工具 —— 登记了就是三个必然失败的按钮）。
 *   省略 = 全部内置。
 * @returns 注册表
 */
export function createToolRegistry(opts: { extra?: readonly ToolEntry[]; include?: readonly string[] } = {}): ToolRegistry {
  const order: string[] = [];
  const byName = new Map<string, ToolEntry>();

  const registry: ToolRegistry = {
    list: () => order.map((name) => byName.get(name)).filter((e): e is ToolEntry => Boolean(e)),
    get: (name) => byName.get(name),
    add: (entries) => {
      for (const entry of entries) {
        if (!byName.has(entry.name)) order.push(entry.name);
        byName.set(entry.name, entry);
      }
    },
  };

  const builtin = builtinToolEntries();
  const only = opts.include ? new Set(opts.include) : null;
  registry.add(only ? builtin.filter((e) => only.has(e.name)) : builtin);
  if (opts.extra?.length) registry.add(opts.extra);
  return registry;
}

/**
 * 把注册表 + 闸门 + 执行体拼成**这一轮下发给模型的工具集**。
 *
 * ## 三件事只在这里做一次
 *
 * 1. **剔除 `hide`**：这一档下不注入的工具根本不在返回的对象里（模型看不到）。
 * 2. **拦下 `ask`**：执行时不真跑，回一条"已交给用户确认、还没执行" ——
 *    口径同 goose / Factor 9：**当成一次工具结果回注**，不抛异常。
 *    ⚠️ 是**执行前**判定，不是"执行了再问"：写着"确认"却已经把事做完，
 *    是这个项目最不能接受的那种"看着有、其实没用"。
 * 3. **深度封顶**：到顶就把 `spawn_agent` **拿掉**（不是拦下）——
 *    "最多一层"因此不需要靠运行时判断去保证。
 *
 * @param input.registry 注册表
 * @param input.mode 闸门档位
 * @param input.executor 宿主绑定的执行体（内核不碰真实工具）
 * @param input.ctx 执行上下文（provider/model/信号/深度）
 * @returns 该档位下的 ToolSet
 */
export function buildToolSet(input: {
  registry: ToolRegistry;
  mode: ConfirmMode;
  executor: ToolExecutor;
  ctx: ExecutorContext;
}): ToolSet {
  const { registry, mode, executor, ctx } = input;
  const depth = ctx.depth ?? 0;

  const kept = new Set(injectableTools(mode, registry.list().map((e) => e.name)));
  if (depth >= MAX_SUBAGENT_DEPTH) kept.delete(SPAWN_AGENT_TOOL);

  const out: ToolSet = {};
  for (const entry of registry.list()) {
    if (!kept.has(entry.name)) continue;
    out[entry.name] = tool({
      description: entry.description,
      inputSchema: entry.inputSchema,
      execute: async (value: unknown) => {
        /*
         * 闸门在这里、执行在宿主。注意判定用的是**当前档位**而不是"建工具集时的档位" ——
         * 两者此刻相同（同一轮），但从这里读一次比闭包捕获更不容易在将来出错。
         */
        if (decide(mode, entry.name) === "ask") {
          return { pending: true, notice: pendingApprovalNotice(entry.name, mode) };
        }
        const result = await executor.run(entry.name, value, ctx);
        /*
         * ⭐ 成功时返回执行体的**原始载荷**，不要那层 `{ ok, output }` 信封。
         *
         * 两处都认原始载荷：模型看到的就是它，而留痕那一行由
         * `describeToolResult(name, ok, output, …)` 生成 —— 那个函数读 `o.count` /
         * `o.title` / `o.pending`。套一层信封的后果不是"多包一层"，是**留痕全部退化成
         * "已完成"**（读不到字段），同时模型多看到一个它没要求的结构。
         *
         * 失败则**抛**出去：SDK 把它变成一次 `tool-error`，主循环再当成 tool result 回注
         * （不变量 3：错误即结果）。只有走这条路，投影才会算出 `ok=false`、
         * 留痕才会写"失败"；返回一个 ok:false 的**正常**载荷会被当成"工具跑成功了"。
         */
        if (result.ok) return result.output;
        throw new Error(toolFailedNotice(entry.name, result.error));
      },
    });
  }
  return out;
}

/**
 * 一次请求会**下发给模型**的工具名（与 `buildToolSet` 用同一套判定）。
 *
 * 存在的理由是日志：只记"用没用工具"是看不出"够得着什么"的 ——
 * 新加的工具到底有没有下发、某档位下是不是被隐藏了，事后都得靠复现。
 *
 * @param registry 注册表
 * @param mode 档位
 * @param depth 嵌套深度
 * @returns 工具名（注入顺序）
 */
export function offeredToolNames(registry: ToolRegistry, mode: ConfirmMode, depth = 0): string[] {
  const names = injectableTools(mode, registry.list().map((e) => e.name));
  if (depth >= MAX_SUBAGENT_DEPTH) return names.filter((n) => n !== SPAWN_AGENT_TOOL);
  return names;
}

/** 未知工具时回给模型的那句话（单一来源在 `shared/agentTools.ts`）。 */
export { toolSpec };
