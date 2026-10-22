import { tool, type FlexibleSchema, type ToolSet } from "ai";

import {
  AGENT_TOOLS,
  MAX_SUBAGENT_DEPTH,
  SPAWN_AGENT_TOOL,
  SPAWN_AGENTS_TOOL,
  toolSpec,
} from "../../shared/agentTools";
import type { ConfirmMode } from "../../shared/ipc";
import { pendingApprovalNotice, toolFailedNotice } from "../core/notices";
import { decideForMember, applyEditMode, injectableTools, policyOf } from "../core/policy";
import { decideCall, type PermissionRule } from "../core/permissionRules";
import { DEFAULT_APPROVER } from "../core/gates";
import type { MemberRole } from "../core/members";
import type { ExecutorContext, ToolExecutor } from "../ports/executor";
import { noopHooks, runHookWithTimeout, type HooksPort } from "../ports/hooks";
import type { SpillPort } from "../ports/spill";
import { applySpill } from "./spill";
import { describeToolResult } from "../../shared/agentTools";
import { selectToolNames } from "./toolSearch";

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

/**
 * 注册表里的一条（D2：带元数据）。
 *
 * `readOnly` 不由各工具手写：它从**权限表**派生（`policyOf(name).kind === "read"`），
 * 两处各写一份迟早出现"说明说只读、闸门按写拦"。
 * 其余字段是调度/落盘策略，内置工具在 `shared/agentTools.ts` 的 `TOOL_META` 里声明，
 * MCP/插件不声明就按保守默认（`add()` 统一补）。
 */
export type ToolEntry = {
  name: string;
  source: ToolSource;
  /** 给模型的说明。 */
  description: string;
  /** 给模型的参数说明 + 执行前校验（zod 或 JSON Schema，`ai` 两种都收）。 */
  inputSchema: FlexibleSchema<unknown>;
  /** 只读（从权限表派生；MCP 可用 `annotations.readOnlyHint` 覆盖为 true）。 */
  readOnly: boolean;
  /** 破坏性（会覆盖/删除/执行命令）。 */
  destructive: boolean;
  /** 调度：`safe` 可并行；`exclusive` 串行（同一工具名排队）。 */
  concurrency: "safe" | "exclusive";
  /** 建议超时（毫秒）；调度层目前只透传，不强制中断。 */
  timeoutMs?: number;
  /** 结果上限（字节）；`spill` 时由执行体落盘。 */
  maxResultBytes?: number;
  resultPolicy: "inline" | "spill" | "tail";
};

/** 一条工具元数据（`ToolEntry` 里除 name/source/description/inputSchema 之外的部分）。 */
export type ToolMeta = Pick<ToolEntry, "destructive" | "concurrency" | "timeoutMs" | "maxResultBytes" | "resultPolicy">;

/**
 * 保守默认：不可并行、不破坏、结果内联。
 * 外部来源（MCP/插件）没声明就是这一份 —— 与"宁可多问一次"同一条口径。
 */
export const DEFAULT_TOOL_META: ToolMeta = {
  destructive: false,
  concurrency: "exclusive",
  resultPolicy: "inline",
};

/**
 * 给一条工具补全元数据（**唯一的收口**）。
 * `readOnly` 永远从权限表取；调用方传来的只作为"外部声明的只读"覆盖：
 * 只有 `true` 能把它放宽到只读，`false` 不会把内置的只读工具变成写。
 */
export function completeToolEntry(
  entry: Pick<ToolEntry, "name" | "source" | "description" | "inputSchema"> & Partial<ToolMeta> & {
    /** MCP 的 `annotations.readOnlyHint`（只有 true 有效）。 */
    readOnlyHint?: boolean;
  },
): ToolEntry {
  const readOnly = policyOf(entry.name).kind === "read" || entry.readOnlyHint === true;
  return {
    name: entry.name,
    source: entry.source,
    description: entry.description,
    inputSchema: entry.inputSchema,
    readOnly,
    destructive: entry.destructive ?? DEFAULT_TOOL_META.destructive,
    concurrency: readOnly && (entry.concurrency ?? DEFAULT_TOOL_META.concurrency) === "safe" ? "safe" : (entry.concurrency ?? DEFAULT_TOOL_META.concurrency),
    ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
    ...(entry.maxResultBytes === undefined ? {} : { maxResultBytes: entry.maxResultBytes }),
    resultPolicy: entry.resultPolicy ?? DEFAULT_TOOL_META.resultPolicy,
  };
}

/**
 * 登记时允许省略元数据（D2 的"统一收口"）：外部来源只给四字段也能登记，
 * `add()` 会补 `readOnly`（从权限表）与保守默认。
 */
export type ToolEntryInput = Pick<ToolEntry, "name" | "source" | "description" | "inputSchema"> &
  Partial<ToolMeta> & { readOnlyHint?: boolean };

export type ToolRegistry = {
  /** 全部已注册的条目（顺序即注入顺序）。 */
  list(): ToolEntry[];
  /** 按名取一条。 */
  get(name: string): ToolEntry | undefined;
  /** 登记一批（重复名字会**覆盖**并保留原位置 —— MCP 重连时工具清单会变）。 */
  add(entries: readonly ToolEntryInput[]): void;
  /**
   * 被拒收的条目（U05）：外部来源想占用**内置工具名**时不予登记。
   *
   * 它是一等结果而不是 console.warn：宿主可以把它显示给用户（"这个插件想冒充
   * 内置的 write_file，已拒绝"）—— 静默丢弃等于让用户以为插件装上了。
   */
  rejected(): Array<{ name: string; source: ToolSource; why: string }>;
};

/**
 * 内置工具那一批。
 *
 * ⚠️ 它**就是** `AGENT_TOOLS`：这里不再手抄一遍说明与 schema。
 * 手抄的代价实测过 —— `WRITE_FILE_MODEL_CHARS` 那种"说明里一个数、执行体里另一个数"
 * 的错就是这么来的（模型照着说明写、被拒绝，然后开始瞎猜）。
 */
export function builtinToolEntries(): ToolEntry[] {
  return AGENT_TOOLS.map((spec) =>
    completeToolEntry({
      name: spec.name,
      source: "builtin" as const,
      description: spec.description,
      inputSchema: spec.schema as FlexibleSchema<unknown>,
      ...(spec.meta ?? {}),
    }),
  );
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
export function createToolRegistry(opts: { extra?: readonly ToolEntryInput[]; include?: readonly string[] } = {}): ToolRegistry {
  const order: string[] = [];
  const byName = new Map<string, ToolEntry>();
  const refused: Array<{ name: string; source: ToolSource; why: string }> = [];

  const registry: ToolRegistry = {
    list: () => order.map((name) => byName.get(name)).filter((e): e is ToolEntry => Boolean(e)),
    get: (name) => byName.get(name),
    rejected: () => [...refused],
    add: (entries) => {
      for (const raw of entries) {
        /* D2：外部来源不写元数据也能登记 —— 这里统一补默认值 */
        const entry = completeToolEntry(raw);
        const existing = byName.get(entry.name);
        /*
         * ⭐ **内置名不许被外部来源占用**（U05，2026-10-18）。
         *
         * 在这之前这里是无条件覆盖：一个 MCP 连接器或插件只要交出一个叫
         * `write_file` 的工具，就能把内置那个换掉 —— 模型以为在写文件，
         * 实际执行的是外部代码。闸门按**工具名**分级，所以覆盖名字等于
         * 让外部代码冒充一个已声明权限级别的内置动作。
         *
         * 同来源的重复仍然覆盖（MCP 重连时工具清单会变，那条语义要保留）。
         */
        if (existing && existing.source === "builtin" && entry.source !== "builtin") {
          refused.push({ name: entry.name, source: entry.source, why: "与内置工具重名（外部来源不能覆盖内置）" });
          continue;
        }
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
/**
 * 同一工具的串行队列（D2）：`concurrency: "exclusive"` 的调用排队，
 * 避免一次回复里两个写动作同时落盘。`readOnly + safe` 不排队（可并行）。
 */
const exclusiveTails = new Map<string, Promise<unknown>>();

function runSerialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prev = exclusiveTails.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(run);
  /* 链尾只留"完成与否"，不留值 —— 失败不会把后面的调用一起带崩 */
  exclusiveTails.set(key, next.catch(() => undefined));
  return next;
}

export function buildToolSet(input: {
  registry: ToolRegistry;
  mode: ConfirmMode;
  executor: ToolExecutor;
  ctx: ExecutorContext;
  /**
   * 只要这些工具（agent 的**白名单**，Phase 7.1）。
   *
   * ⚠️ 它与 `hide` 是**两层**，别混：
   * - `hide` 挡的是"用户这一档不让用"（策略）；
   * - `only` 挡的是"这个角色本来就不该碰"（职责）。
   * 研究员的 `only` 里没有 `write_file` —— 于是它**根本拿不到**写工具，
   * 而不是"拿到了但会被拦"。模型看不到就不会试，也就不会浪费时间。
   *
   * 省略 = 不限制（主对话那个 agent 就是这样）。
   */
  only?: readonly string[];
  /** 当前深度（给 `only` 之外的第二道限制用）。 */
  /**
   * **发起人的角色**（C2，V5-1 3.6b）：人轴那一侧。
   *
   * 缺省 = 不知道是谁（本机单用户）→ 按 owner 处理（老路径一字不变）。
   * 人轴与工具轴叠加的规则在 `engine/core/policy.ts` 的 `decideForMember`（矩阵在 ADR-007）。
   */
  memberRoles?: readonly MemberRole[];
  /**
   * **钩子端口**（V5-4 4.1）：`tool:before` / `tool:after`。
   *
   * 不给 = 没有钩子（`noopHooks`）—— 最小嵌入面（`ding-engine-core`）不装载插件，
   * 而不装载与不接线在这里是同一件事。Node 宿主注入 `pluginHost` 的 `pluginHooks`。
   */
  hooks?: HooksPort;
  /**
   * **工具结果落盘**（U02，2026-10-18）。
   *
   * 给了它就按 `spill.ts` 的策略处理超限结果：全文写进会话私有目录，
   * 回注"前/后 N 行 + 路径"。不给 = 不落盘（最小嵌入面与测试）。
   */
  spill?: SpillPort;
  /**
   * **权限规则**（U03，2026-10-18；加法）。
   *
   * `{action, resource, effect}` 的规则表。给了就参与判定：
   * deny 优先、findLast、无匹配回落到档位；`run_command` 的高风险命令
   * 在「全部允许」下也会被抬成 `ask`（除非有显式 allow 规则）。
   */
  rules?: readonly PermissionRule[];
  /**
   * **工具搜索**（G03）：这一轮用户说了什么。
   *
   * 给了、且工具数超过 `deferThreshold` 时，只下发"核心 + BM25 相关的"，
   * 其余不注入（模型看不到就不会浪费上下文）。省略 = 全量（老行为）。
   */
  query?: string;
  /** 工具数不超过它就全量（默认 40）。 */
  deferThreshold?: number;
}): ToolSet {
  const { registry, mode, executor, ctx } = input;
  const hooks = input.hooks ?? noopHooks;
  const depth = ctx.depth ?? 0;

  const kept = new Set(injectableTools(mode, registry.list().map((e) => e.name)));
  if (input.only) {
    const allow = new Set(input.only);
    for (const name of [...kept]) if (!allow.has(name)) kept.delete(name);
  }
  if (depth >= MAX_SUBAGENT_DEPTH) {
    kept.delete(SPAWN_AGENT_TOOL);
    // 一支小队同理：到顶就不给（模型看不到，就不会试）
    kept.delete(SPAWN_AGENTS_TOOL);
  }
  /*
   * 工具搜索（G03）：工具太多时按这一轮的话做 deferred exposure。
   * ⚠️ `only`（角色白名单）在它**之前**生效 —— 搜索放大不了一个角色本来就没有的工具。
   */
  if (input.query && input.query.trim()) {
    const injected = new Set(selectToolNames(registry.list(), input.query, { threshold: input.deferThreshold }));
    for (const name of [...kept]) if (!injected.has(name)) kept.delete(name);
  }

  const out: ToolSet = {};
  for (const entry of registry.list()) {
    if (!kept.has(entry.name)) continue;
    out[entry.name] = tool({
      description: entry.description,
      inputSchema: entry.inputSchema,
      execute: async (value: unknown, options: { toolCallId?: string } = {}) => {
        /*
         * 闸门在这里、执行在宿主。注意判定用的是**当前档位**而不是"建工具集时的档位" ——
         * 两者此刻相同（同一轮），但从这里读一次比闭包捕获更不容易在将来出错。
         *
         * ⭐ **两轴判定**（C2，V5-1 3.6b）：工具档位 × 发起人的角色。
         * `deny`（人轴不够）与 `ask`（工具轴要问）是**两回事**：
         * 前者**没有执行、也不会等人批**（等一个不会成立的批准 = 白花一轮，见 ADR-007）。
         */
        const gate = decideForMember(
          input.memberRoles ? { roles: input.memberRoles } : undefined,
          mode,
          entry.name,
        );
        if (gate.verdict === "deny") {
          /*
           * 拒绝走**抛错**那条路（与执行失败同一条）：投影会算成 `ok=false`、
           * 留痕写"失败"、模型拿到这句人话（不变量 3：错误即结果）。
           * 返回一个"正常载荷"会被当成"工具跑成功了"——那是最坏的一种谎。
           */
          throw new Error(gate.notice);
        }
        /*
         * ⭐ **规则层与命令风险**（U03）：在档位判定之上再叠一层。
         *
         * 顺序是刻意的：人轴的 `deny` 先判（角色不够 → 直接拒，不等批），
         * 然后才是规则/危险命令。反过来的话，一个被 viewer 拒绝的动作会先被
         * 抬成 `ask`，用户批了还是不生效 —— 那是"把权限问题伪装成审批问题"。
         */
        const call = decideCall({
          base: gate.verdict,
          action: entry.name,
          input: value,
          ...(input.rules?.length ? { rules: input.rules } : {}),
        });
        /*
         * B-01：「接受编辑」在**调用级**放宽（要看路径）。只在没有显式规则命中时
         * 叠加 —— 用户写下来的 allow/ask/deny 永远压过档位的默认语义。
         */
        const verdict =
          call.rule === "none"
            ? applyEditMode({
                mode,
                base: call.verdict,
                action: entry.name,
                input: value,
                ...(ctx.workdirs?.length ? { workdirs: ctx.workdirs } : {}),
              })
            : call.verdict;
        if (verdict === "ask") {
          /*
           * A-03：宿主给了 `approve` 就**当场问**（CLI 的就地审批）。
           *
           * 判定仍然是这一处（policy/规则层）；这里只是决定"人工答案从哪来"。
           * deny 必须走**抛错**那条路（与 `decideForMember` 的 deny 同一条）：
           * 投影会算成 `ok=false`、留痕写"失败"、模型拿到人话。
           * 返回一个正常载荷会被当成"工具跑成功了"——那是最坏的一种谎。
           *
           * `allow-always` 的记账在宿主（引擎不碰存储）；对内核来说它与 `allow`
           * 只差"下一次还会不会问"，而那是宿主下一个请求才需要知道的事。
           */
          if (ctx.approve) {
            const verdict = await ctx.approve({
              name: entry.name,
              input: value,
              ...(call.why ? { why: call.why } : {}),
              ...(call.command ? { commandRisk: call.command } : {}),
              /* F-07：宿主据此把这次"问过/答过"记成可回放的 approval 记录 */
              ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
            });
            if (verdict === "deny") throw new Error(`用户拒绝了这次调用：${entry.name}`);
          } else {
            /*
             * 「待谁批」（C3，V5-1 3.7a）：**拦下那一刻**就写在载荷里 ——
             * 默认 = 这一段会话的 owner（本机单用户 = local；执行上下文里带着它）。
             * 读的时候不现编（见 `engine/core/gates.ts` 的 `approversOf`）。
             */
            return {
              pending: true,
              notice: pendingApprovalNotice(entry.name, mode, call.why),
              approvers: [ctx.owner?.trim() || DEFAULT_APPROVER],
              /* 风险与规则命中一起回注：审批卡片与日志都要能说出"为什么问这一次" */
              ...(call.command ? { commandRisk: call.command } : {}),
              ...(call.rule !== "none" ? { rule: call.rule } : {}),
              ...(call.why ? { why: call.why } : {}),
            };
          }
        }
        /*
         * 钩子（Phase 8.3）：`tool:before` / `tool:after`。
         *
         * ⚠️ 它们是**只看不改**的（返回值忽略）：钩子若能改参数或拦调用，
         * 一个坏插件就能让"模型说它调了 A、实际执行的是 B" —— 而那种事
         * 在留痕里看不出来。要"改行为"的能力等 v2 的隔离方案。
         *
         * 钩子的异常由端口实现内部吞掉并打日志（插件坏了不该变成用户的故障）。
         */
        /*
         * F5：`tool:before` 的返回值**会被消费**（allow / deny / modify）。
         * 超时与抛错一律 deny（fail-closed）—— 插件的故障不该变成用户的故障，
         * 但更不该变成"钩子没说话 = 放行"。
         */
        const before = await runHookWithTimeout(hooks, "tool:before", { name: entry.name, input: value });
        if (!before.ok) throw new Error(`工具调用被钩子拦下：${before.reason}`);
        let effectiveValue = value;
        const decision = before.value as { action?: unknown; input?: unknown; reason?: unknown } | undefined;
        if (decision && typeof decision === "object") {
          if (decision.action === "deny") {
            throw new Error(`工具调用被插件拒绝：${typeof decision.reason === "string" && decision.reason ? decision.reason : "没有说明原因"}`);
          }
          if (decision.action === "modify" && "input" in decision) effectiveValue = decision.input;
        }
        const invoke = (): ReturnType<ToolExecutor["run"]> => executor.run(entry.name, effectiveValue, ctx);
        const result = entry.concurrency === "exclusive" ? await runSerialized(entry.name, invoke) : await invoke();
        await hooks.run("tool:after", { name: entry.name, ok: result.ok, ...(result.error ? { error: result.error } : {}) });
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
        if (result.ok) {
          /*
           * ⭐ **图片内容块**（A-01，2026-10-22）：执行体给了 `media` 就按 AI SDK 的
           * `{type:"content", value:[text, file…]}` 返回 —— 模型才真的看得见截图。
           *
           * 两种形状不能混：给 content 时**不再走 spill**（那份载荷是结构化的，
           * 落盘会把 base64 写成一份大文件，而模型仍然只拿到路径）。
           * 文本那一行仍由 `describeToolResult` 生成（留痕与日志同一口径）。
           */
          if (result.media?.length) {
            return {
              type: "content" as const,
              value: [
                { type: "text" as const, text: describeToolResult(entry.name, true, result.output, undefined, effectiveValue) },
                ...result.media.map((m) => ({ type: "file" as const, mediaType: m.mime, data: m.base64 })),
              ],
            };
          }
          /*
           * 落盘（U02）：**成功结果**才有"完整证据"这回事。
           * 失败的一句人话本来就短，而且它是结论而不是证据。
           */
          return applySpill(entry.name, result.output, input.spill, options.toolCallId ?? `${entry.name}-${Date.now().toString(36)}`);
        }
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
 * @param only 角色白名单（与 `buildToolSet` 的 `only` 同一口径：省略 = 不限制）。
 *   ⚠️ 2026-10-16（审计 P126）：`ding recipe run` 的模板 `tools` 白名单以前**一行都没接**，
 *   而日志里那句"够得着什么"（`request.tools`）记的是全量 —— 记录与实际必须同一口径，
 *   否则日志会为一件没发生的事作证（下发的是白名单那几件，记的却是全套）。
 * @returns 工具名（注入顺序）
 */
export function offeredToolNames(
  registry: ToolRegistry,
  mode: ConfirmMode,
  depth = 0,
  only?: readonly string[],
): string[] {
  let names = injectableTools(mode, registry.list().map((e) => e.name));
  if (only) {
    const allow = new Set(only);
    names = names.filter((n) => allow.has(n));
  }
  if (depth >= MAX_SUBAGENT_DEPTH) {
    return names.filter((n) => n !== SPAWN_AGENT_TOOL && n !== SPAWN_AGENTS_TOOL);
  }
  return names;
}

/** 未知工具时回给模型的那句话（单一来源在 `shared/agentTools.ts`）。 */
export { toolSpec };
