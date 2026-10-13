import { tool, type ToolSet } from "ai";
import {
  CANVAS_ADD_NODE_DESC,
  CANVAS_ADD_NODE_INPUT,
  CANVAS_ADD_NODE_TOOL,
  MAX_SUBAGENT_DEPTH,
  MEMORY_LIST_DESC,
  MEMORY_LIST_INPUT,
  MEMORY_SAVE_DESC,
  MEMORY_SAVE_INPUT,
  MEMORY_SAVE_TOOL,
  MEMORY_LIST_TOOL,
  SCHEDULE_CREATE_DESC,
  SCHEDULE_CREATE_INPUT,
  SCHEDULE_CREATE_TOOL,
  SCHEDULE_LIST_DESC,
  SCHEDULE_LIST_INPUT,
  SCHEDULE_LIST_TOOL,
  SPAWN_AGENT_DESC,
  SPAWN_AGENT_INPUT,
  SPAWN_AGENT_TOOL,
  subagentPrompt,
} from "../../shared/agentTools";
import { decide, injectableTools, pendingApprovalNotice, type ConfirmMode } from "../../shared/permissions";
import { unknownToolNotice } from "../../shared/agentTools";
import { addMemory, MEMORY_MAX } from "../../shared/memory";
import { describeNextRun, makeJob, REPEAT_LABEL, validateJob, type RepeatType } from "../../shared/schedule";
import { readMemory, writeMemory } from "./memoryStore";
import { broadcastScheduleChanged, loadJobs, saveJobs } from "./scheduleStore";
import { sendCanvasCommand } from "./canvas";
import { runSubagent } from "./subagent";

/**
 * 工具的**执行**绑定（§141）。
 *
 * 声明在 `shared/agentTools.ts`（规格层，测试也测它）；这里只做"接到哪个 store"。
 * 分开的理由：schema 只能有一份 —— 两处各写一份必然漂移
 * （本项目在"同一状态两处渲染"上已经栽过多次）。
 *
 * 执行放在**主进程**是有意的，也是后面「审批闸门」能成立的前提：
 * 工具的落点全部在主进程的 store（记忆 / 画布 / 定时任务 / 产物），
 * 渲染进程绕不过去 —— 所以"每次工具调用过一道校验"只要在这一层做一次。
 * （研究结论：Cline 的 `requestToolApproval` 是**注入给 agent 的一个能力回调**，
 * 不写死在循环里；等批次 2 就把它接在这一层。）
 */

/**
 * 把一条内容存进记忆。
 *
 * 落盘走 `writeMemory`（与 IPC 同一条路径）—— 两处必须一致，
 * 否则"工具写的"与"界面读的"会不一样。
 *
 * @param text 要记住的内容
 * @returns 给模型看的结果（含当前条数，方便它判断要不要继续）
 */
function saveToMemory(text: string): { ok: boolean; count: number; note?: string } {
  const before = readMemory();
  const next = addMemory(before, text, { source: "conversation" });
  if (next === before) {
    // addMemory 在"空文本"或"已经有一模一样的"时原样返回
    return { ok: true, count: before.entries.length, note: "这条已经记过了，没有重复添加" };
  }
  if (before.entries.length >= MEMORY_MAX && next.entries.length >= MEMORY_MAX) {
    return { ok: true, count: next.entries.length, note: `记忆已满（上限 ${MEMORY_MAX} 条），这条没有存进去` };
  }
  writeMemory(next);
  return { ok: true, count: next.entries.length };
}

/** 列出全部记忆条目。 */
function listMemory(): { count: number; entries: string[] } {
  const lib = readMemory();
  return { count: lib.entries.length, entries: lib.entries.map((e) => e.text) };
}

/**
 * **执行体**：工具名 → 干活的那块。
 *
 * 单独抽出来是因为有**两个调用方**：
 * ① 模型调用（过审批闸门，`agentTools()`）；
 * ② **用户点了「允许」**（`runToolOnce()`，绕过闸门 —— 再判一次只会永远拦着）。
 *
 * 两份必须共用同一段逻辑，否则"模型直接调"与"用户放行后执行"会慢慢长歪。
 */
const EXECUTORS: Record<string, (input: unknown, env: ToolEnv) => Promise<unknown> | unknown> = {
  [MEMORY_SAVE_TOOL]: (input) => saveToMemory((input as { text: string }).text),
  [MEMORY_LIST_TOOL]: () => listMemory(),

  /**
   * 建一个定时任务。
   *
   * 复用共享层的 `makeJob` / `validateJob`（与界面同一条路），
   * 不自己拼对象 —— 否则"工具建的"和"界面建的"会在字段上慢慢分叉。
   *
   * 写完要**广播变更**：渲染侧的调度器用内存里那份列表，不通知就跑到旧列表上（§145）。
   */
  [SCHEDULE_CREATE_TOOL]: async (input) => {
    const { title, prompt, repeat, customMinutes } = input as {
      title: string;
      prompt: string;
      repeat: RepeatType;
      customMinutes?: number;
    };
    const now = Date.now();
    const job = makeJob(
      `job_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      title,
      prompt,
      repeat,
      // 本机版没有云端执行环境，如实标成本机（与界面上的默认一致）
      "localDevice",
      now,
      customMinutes,
    );
    const bad = validateJob(job);
    if (bad) return { ok: false, error: bad };

    const jobs = await loadJobs();
    const saved = await saveJobs([...jobs, job]);
    if (!saved) return { ok: false, error: "写盘失败" };
    broadcastScheduleChanged();
    return {
      count: jobs.length + 1,
      title: job.title,
      next: describeNextRun(job.nextRunAt, now) ?? "",
    };
  },

  /** 列出定时任务。只读，信息量够模型判断"要不要再建一个"。 */
  [SCHEDULE_LIST_TOOL]: async () => {
    const jobs = await loadJobs();
    const active = jobs.filter((j) => j.status === "running");
    return {
      count: active.length,
      jobs: active.slice(0, 20).map((j) => ({
        title: j.title,
        repeat: REPEAT_LABEL[j.repeat],
        next: describeNextRun(j.nextRunAt, Date.now()),
      })),
    };
  },

  /**
   * 往画布加节点（§146）。
   *
   * ⚠️ **主进程不直接改画布文档** —— 文档由渲染进程持有，直接写会被自动保存覆盖。
   * 这里只"发命令 + 等回执"，由渲染进程真正把节点加上。
   */
  [CANVAS_ADD_NODE_TOOL]: async (input) => {
    const { kind, text, lang } = input as { kind: "markdown" | "code"; text: string; lang?: string };
    const result = await sendCanvasCommand({ kind, text, ...(lang ? { lang } : {}) });
    if (!result.ok) return { ok: false, error: result.error ?? "画布没有完成这个操作" };
    return { ok: true, kind, nodeId: result.nodeId, opened: result.opened };
  },

  /**
   * 派一个子智能体（§150）。
   *
   * 这里只做三件事：建**同一档位**的工具集（审批穿透）→ 跑 → 把要点报告回给父级。
   * **深度加一**并把新工具集传下去 —— 这样"最多一层"是靠**工具集里没有 spawn_agent**
   * 保证的，而不是靠运行时判断（模型看不到它，就不会试了才失败）。
   */
  [SPAWN_AGENT_TOOL]: async (input, env) => {
    const { task, context } = input as { task: string; context?: string };
    const depth = (env.depth ?? 0) + 1;
    const subTools = agentTools({ ...env, depth });
    const { system, user } = subagentPrompt(task, context);
    return runSubagent({
      provider: env.provider,
      ...(env.model ? { model: env.model } : {}),
      system,
      user,
      tools: subTools,
    });
  },
};

/**
 * 用户批准后执行一次工具（**不再过闸门**）。
 *
 * ⚠️ 安全口径要说清：**这道闸是"别让模型擅自做事"的产品闸，不是安全边界** ——
 * 渲染进程本来就能直接调各 store 的 IPC。所以这里不做额外授权校验；
 * 但也因此**不要**把它当成安全机制来依赖。
 *
 * @param name 工具名
 * @param input 模型当时给的那份参数（原样执行，不让前端改）
 * @returns 成败与结果；界面要显示的那一行由调用方用 `describeToolResult` 生成
 */
export async function runToolOnce(
  name: string,
  input: unknown,
  /**
   * 放行时需要"环境"（§150）。
   *
   * ⚠️ 用户点「允许」时，**父请求的上下文已经没了**（那次流早结束了）。
   * 对 `spawn_agent` 来说这不是问题：**子智能体是用自己的上下文跑的**，
   * 换成哪个 provider 只影响成本与质量，不影响语义。所以调用方给一个默认 provider 即可。
   */
  env: ToolEnv = { mode: "全部允许", provider: "" },
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  const run = EXECUTORS[name];
  // 未知工具：回一句"没有这个工具"，而不是抛异常（口径同 unknownToolNotice）
  if (!run) return { ok: false, error: unknownToolNotice(name) };
  try {
    return { ok: true, output: await run(input, env) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 给一次执行套上审批闸门（§143）。
 *
 * `ask` 档下**不执行**，回一条"已交给用户确认"的结果 —— 口径同 goose / Factor 9：
 * 当成一次工具结果回注，让模型知道"没执行、在等谁、别重试"。
 *
 * 注意这里是**执行前**判定（不是"执行了再问"）：写着"确认"却已经把事做完，
 * 那是本项目最不能接受的那种"看着有、其实没用"。
 */
function gated<T>(name: string, mode: ConfirmMode, run: (input: T, env: ToolEnv) => Promise<unknown> | unknown, env: ToolEnv) {
  return async (input: T): Promise<unknown> => {
    if (decide(mode, name) === "ask") {
      return { pending: true, notice: pendingApprovalNotice(name, mode) };
    }
    return run(input, env);
  };
}
/**
 * 一次请求的"环境"（§150）。
 *
 * 工具执行需要知道三件事，它们都不是工具自己有的：
 * ① 闸门档位 `mode`（判定用）；② 主请求用的 provider/model（子智能体要沿用同一个）；
 * ③ 嵌套深度 `depth`（防止子智能体再派子智能体）。
 */
export type ToolEnv = {
  mode: ConfirmMode;
  provider: string;
  model?: string;
  depth?: number;
};

/**
 * 交给模型的工具集。
 *
 * @param env 闸门档位 / provider / 深度
 * @returns 该档位下应当注入的工具；被 `hide` 的**不在这里**（模型看不到它）
 */
export function agentTools(env: ToolEnv): ToolSet {
  const { mode, depth = 0 } = env;
  const tools: ToolSet = {
    [MEMORY_SAVE_TOOL]: tool({
      description: MEMORY_SAVE_DESC,
      inputSchema: MEMORY_SAVE_INPUT,
      execute: gated<{ text: string }>(MEMORY_SAVE_TOOL, mode, (input) => EXECUTORS[MEMORY_SAVE_TOOL](input, env), env),
    }),
    [MEMORY_LIST_TOOL]: tool({
      description: MEMORY_LIST_DESC,
      inputSchema: MEMORY_LIST_INPUT,
      execute: gated<Record<string, never>>(MEMORY_LIST_TOOL, mode, (input) => EXECUTORS[MEMORY_LIST_TOOL](input, env), env),
    }),
    [SCHEDULE_CREATE_TOOL]: tool({
      description: SCHEDULE_CREATE_DESC,
      inputSchema: SCHEDULE_CREATE_INPUT,
      execute: gated<{ title: string; prompt: string; repeat: RepeatType; customMinutes?: number }>(
        SCHEDULE_CREATE_TOOL,
        mode,
        (input) => EXECUTORS[SCHEDULE_CREATE_TOOL](input, env),
        env,
      ),
    }),
    [SCHEDULE_LIST_TOOL]: tool({
      description: SCHEDULE_LIST_DESC,
      inputSchema: SCHEDULE_LIST_INPUT,
      execute: gated<Record<string, never>>(SCHEDULE_LIST_TOOL, mode, (input) => EXECUTORS[SCHEDULE_LIST_TOOL](input, env), env),
    }),
    [CANVAS_ADD_NODE_TOOL]: tool({
      description: CANVAS_ADD_NODE_DESC,
      inputSchema: CANVAS_ADD_NODE_INPUT,
      execute: gated<{ kind: "markdown" | "code"; text: string; lang?: string }>(
        CANVAS_ADD_NODE_TOOL,
        mode,
        (input) => EXECUTORS[CANVAS_ADD_NODE_TOOL](input, env),
        env,
      ),
    }),
    [SPAWN_AGENT_TOOL]: tool({
      description: SPAWN_AGENT_DESC,
      inputSchema: SPAWN_AGENT_INPUT,
      execute: gated<{ task: string; context?: string }>(SPAWN_AGENT_TOOL, mode, (input) =>
        EXECUTORS[SPAWN_AGENT_TOOL](input, env), env,
      ),
    }),
  };

  /*
   * `hide` 的从注入列表里去掉。
   * 与"注入了但一律被拒"是两回事：模型看不到，就不会在回复里说
   * "我来调用 xxx" 然后失败 —— 那种失败会让人以为产品坏了。
   */
  const keep = new Set(injectableTools(mode, Object.keys(tools)));

  /*
   * ⭐ 深度到顶就把 `spawn_agent` **拿掉**（§150）。
   *
   * 注意是"拿掉"而不是"拦下"：模型看不到它，就不会试着派子智能体然后失败。
   * 这也让"最多一层"这件事**不需要靠运行时判断**去保证。
   */
  if (depth >= MAX_SUBAGENT_DEPTH) keep.delete(SPAWN_AGENT_TOOL);

  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    if (keep.has(name)) out[name] = t;
  }
  return out;
}

/** 供测试与"未知工具回注"用的清单。 */
export const TOOL_NAMES = [
  MEMORY_SAVE_TOOL,
  MEMORY_LIST_TOOL,
  SCHEDULE_CREATE_TOOL,
  SCHEDULE_LIST_TOOL,
  CANVAS_ADD_NODE_TOOL,
  SPAWN_AGENT_TOOL,
] as const;
