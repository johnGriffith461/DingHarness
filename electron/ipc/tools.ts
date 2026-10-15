import { jsonSchema, type ToolSet } from "ai";
import { isMcpTool, parseMcpToolName } from "../../shared/mcp";
import {
  CANVAS_ADD_NODE_TOOL,
  SPAWN_AGENTS_TOOL,
  EDIT_FILE_TOOL,
  LIST_DIR_TOOL,
  LIST_FILES_TOOL,
  MEMORY_LIST_TOOL,
  MEMORY_SAVE_TOOL,
  READ_FILE_TOOL,
  RUN_COMMAND_TOOL,
  SCHEDULE_CREATE_TOOL,
  SCHEDULE_LIST_TOOL,
  SEARCH_FILES_TOOL,
  SPAWN_AGENT_TOOL,
  subagentPrompt,
  WRITE_FILE_TOOL,
} from "../../shared/agentTools";
import type { ConfirmMode } from "../../shared/ipc";
import { unknownToolNotice } from "../../engine/core/notices";
import {
  buildToolSet,
  createToolRegistry,
  pluginToolEntries,
  type ToolEntry,
} from "../../engine/runtime/registry";

export { pluginToolEntries };
import type { ToolExecutor } from "../../engine/ports/executor";
import { formatFileList } from "../../shared/fileList";
import { addMemory, MEMORY_MAX } from "../../shared/memory";
import { describeNextRun, makeJob, REPEAT_LABEL, validateJob, type RepeatType } from "../../shared/schedule";
import { readMemory, writeMemory } from "./memoryStore";
import { broadcastScheduleChanged, loadJobs, saveJobs } from "./scheduleStore";
import { sendCanvasCommand } from "./canvas";
import { describeReadResult, readFileForModel } from "../../engine/runtime/tools/readTool";
import { describeWriteResult, writeFileForModel } from "../../engine/runtime/tools/writeTool";
import { describeEditResult, editFileForModel } from "../../engine/runtime/tools/editTool";
import { describeRunResult, runCommandForModel } from "../../engine/runtime/tools/execTool";
import { nothingFoundNote } from "../../engine/runtime/tools/searchTool";
import { callMcpTool, mcpToolBindings } from "./mcpStore";
import { describeListDirResult, describeSearchResult, listDirForModel, searchFilesForModel } from "../../engine/runtime/tools/searchTool";
import { listDrive, ownedDirs } from "./driveStore";
import { runSubagent } from "../../engine/runtime/subagent";
import { runTeam } from "../../engine/runtime/team";
import { isPluginTool } from "../../engine/runtime/plugins";
import { runPluginTool } from "../../engine/runtime/pluginHost";

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
 * ⚠️ C1：`readMemory` / `writeMemory` 现在是**异步**的（落盘要重试就不可能同步，
 * 同步重试会把主进程连同界面一起卡住）。`EXECUTORS` 本来就允许返回 Promise，
 * 所以这里跟着改成 async 即可。
 *
 * @param text 要记住的内容
 * @returns 给模型看的结果（含当前条数，方便它判断要不要继续）
 */
async function saveToMemory(text: string): Promise<{ ok: boolean; count: number; note?: string }> {
  const before = await readMemory();
  const next = addMemory(before, text, { source: "conversation" });
  if (next === before) {
    // addMemory 在"空文本"或"已经有一模一样的"时原样返回
    return { ok: true, count: before.entries.length, note: "这条已经记过了，没有重复添加" };
  }
  if (before.entries.length >= MEMORY_MAX && next.entries.length >= MEMORY_MAX) {
    return { ok: true, count: next.entries.length, note: `记忆已满（上限 ${MEMORY_MAX} 条），这条没有存进去` };
  }
  await writeMemory(next);
  return { ok: true, count: next.entries.length };
}

/** 列出全部记忆条目。 */
async function listMemory(): Promise<{ count: number; entries: string[] }> {
  const lib = await readMemory();
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
   * 读用户目录里的一个文本文件（2026-10-14）。
   *
   * 在此之前 agent **看不见用户提到的任何文件** —— "把云盘里的季度总结改成三行"这种话
   * 它只能靠编。这个执行体把读取收在一处：
   *   · 目录白名单与 `drive:read` 共用（`ownedDirs()`），不各写一份；
   *   · 大小上限、二进制判定、各种"读不到"的分支都在 `readTool.ts`（纯函数、有单测）；
   *   · 返回的那句话（`describeReadResult`）同时用于**界面留痕**，两边不会说法不一。
   */
  [READ_FILE_TOOL]: async (input) => {
    const { path } = input as { path: string };
    const result = await readFileForModel(path, ownedDirs());
    return {
      ok: result.ok,
      line: describeReadResult(result, path),
      ...(result.ok ? { text: result.text, chars: result.chars, truncated: result.truncated } : { error: result.error }),
    };
  },

  /**
   * 写文件（2026-10-14）。
   *
   * 与「读文件」配成一套：能读不能写，agent 就只能把产出吐在对话里。
   * 所有"写不写得进去"的判断都在 `writeTool.ts`（纯函数、有单测）：
   * 目录白名单、默认拒绝覆盖、二进制扩展名、正文上限 —— 一条都不在这里现写。
   */
  [WRITE_FILE_TOOL]: async (input) => {
    const { path, content, overwrite } = input as { path: string; content: string; overwrite?: boolean };
    const result = await writeFileForModel(path, content, ownedDirs(), overwrite === true);
    return {
      ok: result.ok,
      line: describeWriteResult(result, path),
      ...(result.ok
        ? { path: result.path, chars: result.chars, bytes: result.bytes, created: result.created }
        : { error: result.error }),
    };
  },

  /**
   * 看目录 / 找文件 / 改文件 / 跑命令（2026-10-14，一批四件）。
   *
   * 全部判断都在各自的纯模块里（`searchTool.ts` / `editTool.ts` / `execTool.ts`）：
   * 目录白名单、上限、跳过的目录、超时与截断 —— 这里只做转接与"说成一句话"。
   */
  [LIST_DIR_TOOL]: async (input) => {
    const { path, depth, pattern } = input as { path?: string; depth?: number; pattern?: string };
    const result = await listDirForModel({ path, depth, pattern }, ownedDirs());
    return {
      ok: result.ok,
      line: describeListDirResult(result, path ?? "(授权目录)"),
      ...(result.ok
        ? {
            entries: result.entries.length,
            truncated: result.truncated,
            text: result.entries.length ? result.entries.join("\n") : nothingFoundNote("这个目录"),
          }
        : { error: result.error }),
    };
  },

  [SEARCH_FILES_TOOL]: async (input) => {
    const { pattern, path, include, literal, limit } = input as {
      pattern: string;
      path?: string;
      include?: string;
      literal?: boolean;
      limit?: number;
    };
    const result = await searchFilesForModel({ pattern, path, include, literal, limit }, ownedDirs());
    return {
      ok: result.ok,
      line: describeSearchResult(result, pattern),
      ...(result.ok
        ? {
            count: result.matches.length,
            truncated: result.truncated,
            text: result.matches.length ? result.matches.join("\n") : nothingFoundNote("这一搜"),
          }
        : { error: result.error }),
    };
  },

  [EDIT_FILE_TOOL]: async (input) => {
    const { path, oldText, newText, replaceAll } = input as {
      path: string;
      oldText: string;
      newText: string;
      replaceAll?: boolean;
    };
    const result = await editFileForModel(path, oldText, newText, ownedDirs(), replaceAll === true);
    return {
      ok: result.ok,
      line: describeEditResult(result, path),
      /* ⚠️ 字段名不能叫 `line`：那是留痕那一行用的键，重名会被静默覆盖 */
      ...(result.ok ? { path: result.path, replaced: result.replaced, atLine: result.line } : { error: result.error }),
    };
  },

  [RUN_COMMAND_TOOL]: async (input) => {
    const { command, workdir, timeout } = input as { command: string; workdir?: string; timeout?: number };
    const result = await runCommandForModel({ command, workdir, timeout }, ownedDirs());
    return {
      ok: result.ok,
      line: describeRunResult(result, command),
      ...(result.ok
        ? { exitCode: result.exitCode, cwd: result.cwd, truncated: result.truncated, timedOut: result.timedOut, text: result.output }
        : { error: result.error }),
    };
  },

  /**
   * 列用户目录里的文件（2026-10-14）。
   *
   * 与「读文件」是一对：只读会让 agent"只能处理用户报得出名字的文件" ——
   * 问"我云盘里有什么""把云盘里的文档整理成目录"就卡住了。
   * 复用 `listDrive()`（云盘页那份，含同名去重与隐藏文件过滤）——
   * 不另写一遍扫描，"界面上看到的"与"agent 看到的"才不会分叉。
   */
  [LIST_FILES_TOOL]: async () => {
    const entries = await listDrive();
    return { count: entries.length, line: `列了 ${entries.length} 个文件`, text: formatFileList(entries) };
  },

  /**
   * 派**一支小队**（Phase 7.2）：几件事并行交给几个专家，汇合后回一份报告。
   *
   * 与下面 `spawn_agent` 的关系：**一个原语（`runSubagent`）的两个入口**。
   * 单件走 `spawn_agent`（沿用原有提示词，历史行为一字不变）；
   * 多件走这里（按 `AgentSpec` 派活、并行、进度可见）。
   * 分开而不是合并，是因为合并会改掉单件那条路的行为 —— 而那一路有既有日志与验收在看着。
   */
  [SPAWN_AGENTS_TOOL]: async (input, env) => {
    const { tasks } = input as { tasks: { agent: string; task: string; context?: string }[] };
    return runTeam({
      tasks: tasks ?? [],
      provider: env.provider,
      ...(env.model ? { model: env.model } : {}),
      callerMode: env.mode,
      makeTools: (mode, depth, provider, signal, only) =>
        agentTools({
          ...env,
          mode,
          depth,
          provider,
          ...(signal ? { signal } : {}),
          ...(only ? { only } : {}),
        }),
      ...(env.signal ? { signal: env.signal } : {}),
      depth: env.depth ?? 0,
      ...(env.onDelegation ? { onDelegation: env.onDelegation } : {}),
    });
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
      // 父级被停止时子级一起停（信号一路从 ai:chat 传到这里）
      ...(env.signal ? { signal: env.signal } : {}),

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
  /*
   * 连接器（MCP）工具**不在 `EXECUTORS` 这个静态表里**（它们是运行时才出现的，
   * 取决于用户配了哪些 server）。所以先按名字分流：认得出前缀就走连接器。
   * 这条同时让"用户点批准后再执行"那条路（`ai:runTool`）对 MCP 工具也成立。
   */
  if (isMcpTool(name)) {
    const res = await callMcpTool(name, input);
    if (!res.ok) return { ok: false, error: res.error };
    const parsed = parseMcpToolName(name);
    return {
      ok: true,
      output: {
        ok: !res.isError,
        line: describeMcpLine(parsed?.server ?? "?", parsed?.tool ?? name, res.isError),
        text: res.text,
        ...(res.isError ? { error: res.text } : {}),
      },
    };
  }

  /*
   * 插件工具（Phase 8.3）：与 MCP 同一条思路 —— 名字带前缀，运行时按前缀分流。
   * 插件不在 `EXECUTORS` 静态表里（它们是用户装出来的，装什么得看台账）。
   */
  if (isPluginTool(name)) {
    try {
      return { ok: true, output: await runPluginTool(name, input) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const run = EXECUTORS[name];
  // 未知工具：回一句"没有这个工具"，而不是抛异常（口径同 unknownToolNotice）
  if (!run) return { ok: false, error: unknownToolNotice(name) };
  try {
    return { ok: true, output: await run(input, env) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
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
  /** 只有这些工具（agent 白名单，Phase 7.1）。省略 = 不限制。 */
  only?: readonly string[];
  /** 委派进度上报（Phase 7.3）—— 小队用它让"谁在跑"可见。 */
  onDelegation?: (event: {
    delegationId: string;
    agent: string;
    task: string;
    status: "started" | "finished";
    ok?: boolean;
    summary?: string;
    steps?: number;
    error?: string;
  }) => void;
  /**
   * 这一轮的中止信号（C2-3）。
   *
   * ⚠️ 它一路传到 `spawn_agent` → `runSubagent`：用户点停时**子智能体也得停**。
   * 在此之前子智能体压根拿不到信号 —— 表现是"点了停止，后台还在跑、还在花钱"。
   *
   * ⚠️ 放行路径（`ai:runTool`）**没有**信号：那次请求的上下文早就结束了（§144），
   * 所以从放行启动的子智能体不可中止 —— 如实记着这个边界。
   */
  signal?: AbortSignal;
};

/**
 * 宿主的**执行体**：内核只认 `ToolExecutor` 这个接口，这里把它接到真实工具上。
 *
 * ⚠️ 它同时是"宿主边界"的落点：内核（`engine/`）不知道记忆/画布/定时任务存在，
 * 只知道"给我名字和参数，我给你结果"。
 */
export const hostExecutor: ToolExecutor = {
  run: (name, input, ctx) =>
    runToolOnce(name, input, {
      mode: ctx.mode,
      provider: ctx.provider,
      ...(ctx.model ? { model: ctx.model } : {}),
      ...(ctx.depth === undefined ? {} : { depth: ctx.depth }),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(ctx.onDelegation ? { onDelegation: ctx.onDelegation } : {}),
    }),
};

/**
 * 连接器（MCP）交出来的工具 → 注册表条目。
 *
 * schema 用服务端给的 JSON Schema **直接转**（`jsonSchema()`）—— 不重新描述一遍：
 * MCP 服务端本来就是按 JSON Schema 暴露参数的，再抄一份必然漂移。
 */
export function mcpToolEntries(): ToolEntry[] {
  return mcpToolBindings().map((binding) => ({
    name: binding.localName,
    source: "mcp" as const,
    description: binding.description,
    inputSchema: jsonSchema((binding.inputSchema as never) ?? { type: "object", properties: {} }),
  }));
}

/**
 * 交给模型的工具集。
 *
 * ⚠️ 这里的每一件事都已收进内核（`engine/runtime/registry.ts`）：
 * 有哪些工具、哪些该 `hide`、哪些要 `ask`、深度封顶 —— 本函数只是**装配**：
 * 内置声明来自 `AGENT_TOOLS`，连接器工具来自 MCP，执行体是本文件上面那个。
 * 在这之前，13 个工具每个都手抄一遍 `description`/`inputSchema`/`execute`，
 * 于是"说明"与"判定"与"执行"三份东西各长各的。
 *
 * @param env 闸门档位 / provider / 深度
 * @returns 该档位下应当注入的工具；被 `hide` 的**不在这里**（模型看不到它）
 */
export function agentTools(env: ToolEnv): ToolSet {
  return buildToolSet({
    // 三个来源：内置（注册表自带）/ 连接器（MCP）/ 插件（Phase 8.3）
    registry: createToolRegistry({ extra: [...mcpToolEntries(), ...pluginToolEntries()] }),
    mode: env.mode,
    executor: hostExecutor,
    ...(env.only ? { only: env.only } : {}),
    ctx: {
      mode: env.mode,
      provider: env.provider,
      ...(env.model ? { model: env.model } : {}),
      ...(env.signal ? { signal: env.signal } : {}),
      ...(env.depth === undefined ? {} : { depth: env.depth }),
      ...(env.onDelegation ? { onDelegation: env.onDelegation } : {}),
    },
  });
}

/**
 * 连接器工具执行完的那句话（界面留痕与回给模型共用）。
 *
 * @param server 哪个连接器
 * @param tool 它那边的工具名
 * @param failed 服务端是否把它标成失败
 * @returns 一句话
 */
function describeMcpLine(server: string, tool: string, failed: boolean): string {
  return `${failed ? "连接器报错" : "连接器已执行"}：${server} · ${tool}`;
}

/** 供测试与"未知工具回注"用的清单。 */
export const TOOL_NAMES = [
  SPAWN_AGENTS_TOOL,
  MEMORY_SAVE_TOOL,
  MEMORY_LIST_TOOL,
  SCHEDULE_CREATE_TOOL,
  SCHEDULE_LIST_TOOL,
  CANVAS_ADD_NODE_TOOL,
  SPAWN_AGENT_TOOL,
  READ_FILE_TOOL,
  LIST_FILES_TOOL,
  WRITE_FILE_TOOL,
  LIST_DIR_TOOL,
  SEARCH_FILES_TOOL,
  EDIT_FILE_TOOL,
  RUN_COMMAND_TOOL,
] as const;
