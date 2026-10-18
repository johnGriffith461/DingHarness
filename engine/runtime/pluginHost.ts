import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { jsonSchema } from "ai";

import type { ToolEntry } from "./registry";
import {
  grantedCapabilities,
  pluginToolName,
  type HookName,
  type PluginPermission,
} from "./plugins";
import { manifestDrifted, readManifestFromDir, type InstalledPlugin } from "../adapters/pluginStore";
import { PRODUCT_VERSION } from "../../shared/product";
import { engineIncompatibility } from "./pluginIndex";
import { checkManifest } from "./plugins";
import { dependencyProblems } from "./pluginDeps";
import { startIsolatedPlugin, type IsolatedPlugin } from "./pluginWorker";
import type { HooksPort } from "../ports/hooks";

/**
 * **插件的装载与运行**（Phase 8.3）。
 *
 * ## 一个插件长什么样（作者写的那一面）
 *
 * ```js
 * // index.mjs
 * export const tools = {
 *   hello: {
 *     description: "打个招呼",
 *     inputSchema: { type: "object", properties: {} },
 *     run: async (input, ctx) => ({ ok: true, text: "你好" }),
 *   },
 * };
 * export const hooks = {
 *   "turn:end": async (payload) => { /* 观察，不改变任何东西 *\/ },
 * };
 * ```
 *
 * ## 三条边界（G18 之后）
 *
 * 1. **独立进程执行**：插件代码跑在 Worker 里（`pluginWorker.ts`），不在主进程 ——
 *    死循环/崩溃只毁它自己；文件与子进程按批准项由 Node 权限模型强制。
 *    **例外如实记**：`net` 仍拦不住（Node 没有网络权限那一格）。
 * 2. **钩子是"只看不改"**：钩子的返回值**一律忽略**。钩子能改行为的话，
 *    一个坏插件就能悄悄改掉工具参数或拦下工具调用 —— 而那种改动
 *    在留痕里看不出来（"模型说它调了 A，结果执行的是 B"）。
 * 3. **名字带前缀**（`plugin__<插件>__<工具>`）：插件顶不掉内置工具，
 *    而"谁提供的能力"在留痕里一眼可辨（与 MCP 的 `mcp__` 同一个道理）。
 *
 * ## 权限在这里**真的**生效
 *
 * `tools:register` / `hooks:register` 没被批准 → 那条线**不接**：
 * 工具不进注册表、钩子不会被调用。`fs:read` / `fs:write` / `exec` 由 worker
 * 的启动参数决定（`isolation` 字段如实标 `worker-permission` 还是 `worker`）。
 */

/** 插件工具的运行体。 */
export type PluginToolRun = (input: unknown, ctx: { sessionId?: string }) => Promise<unknown> | unknown;

/** 装载结果。 */
export type LoadedPlugin = {
  name: string;
  version: string;
  dir: string;
  /** 可以进注册表的条目（已带前缀）。 */
  entries: ToolEntry[];
  /** 实际接上的钩子。 */
  hooks: Partial<Record<HookName, (payload: unknown) => unknown>>;
  /** 被扣下的能力（用户没批的注入类权限）—— 界面上要说出来。 */
  withheld: PluginPermission[];
  /** 装载过程中发现的问题（**报出来而不是吞掉**：插件少了一个工具，用户该知道）。 */
  problems: string[];
  /**
   * 隔离档位（G18）：`worker-permission` = 独立进程 + Node 权限模型（文件/子进程受控）；
   * `worker` = 独立进程（崩溃/卡死隔离，但文件与命令边界**没有强制**）。
   * 缺省 = 早期台账/未装载。
   */
  isolation?: "worker-permission" | "worker";
};

/**
 * 插件给的参数说明收窄成一份合法的 JSON Schema。
 *
 * ⚠️ 它可能什么都没有（作者偷懒）或者不是对象（写错了）—— 两种都退回
 * "一个空对象 schema"，而不是把坏东西交给 SDK（那会在建工具集时炸，
 * 而炸的位置离原因很远）。**"没有参数说明"与"参数说明是垃圾"都不该让插件装不上**：
 * 工具照样能用，只是模型对参数更糊涂一点。
 */
function normalizeSchema(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return { type: "object", properties: {} };
}

/** 已装载的工具运行体（键是带前缀的完整名字）。 */
const runners = new Map<string, PluginToolRun>();
/**
 * 已起的隔离进程（G18）：插件名 → worker 句柄。
 *
 * 与 `runners` 分开：`runners` 是"怎么调"（工具名 → 调用），这里是"进程在哪"
 * （重装载/退出时要 terminate）。
 */
const workers = new Map<string, IsolatedPlugin>();

/** 当前装载的插件（宿主从这里取条目与钩子）。 */
let loaded: LoadedPlugin[] = [];

/** 当前装载的所有插件。 */
export function loadedPlugins(): readonly LoadedPlugin[] {
  return loaded;
}

/** 注册表条目：所有已装载插件的工具（与 `mcpToolEntries()` 对称）。 */
export function pluginToolEntries(): ToolEntry[] {
  return loaded.flatMap((p) => p.entries);
}

/** 全部被扣下的能力（界面上"它申请了但你没批"那段）。 */
export function withheldCapabilities(): { plugin: string; permissions: PluginPermission[] }[] {
  return loaded.filter((p) => p.withheld.length).map((p) => ({ plugin: p.name, permissions: p.withheld }));
}

/**
 * 插件工具的资源上限（G18，2026-10-18）。
 *
 * ⚠️ 插件现在跑在**独立 Worker**（G18，见 `pluginWorker.ts`）：超时会 terminate 那个进程；
 * 结果上限仍在这里（挡"吐出一个吃爆上下文的巨大结果"）。
 */
export const PLUGIN_TOOL_TIMEOUT_MS = 30_000;
/** 钩子上限：钩子是"只看不改"的旁路，超过 5 秒就当它卡住了。 */
export const PLUGIN_HOOK_TIMEOUT_MS = 5_000;
export const PLUGIN_TOOL_MAX_CHARS = 64 * 1024;

/**
 * 跑一个插件工具。
 *
 * @param name 带前缀的完整名字
 * @param input 模型给的参数
 * @returns 原样返回插件的结果；插件抛错则如实抛出（由执行体那条统一的路翻成 tool result）
 */
export async function runPluginTool(name: string, input: unknown): Promise<unknown> {
  const run = runners.get(name);
  if (!run) throw new Error(`没有这个插件工具：${name}（插件可能被卸载或关掉了）`);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`插件工具「${name}」${Math.round(PLUGIN_TOOL_TIMEOUT_MS / 1000)} 秒没有返回，已放弃这次调用`)),
      PLUGIN_TOOL_TIMEOUT_MS,
    );
  });
  try {
    const result = await Promise.race([run(input, {}), timeout]);
    /* 结果过大就**截断并说明**（不静默丢；也不把几十兆塞进上下文） */
    const text = typeof result === "string" ? result : (() => {
      try {
        return JSON.stringify(result);
      } catch {
        return "";
      }
    })();
    if (text.length > PLUGIN_TOOL_MAX_CHARS) {
      return {
        ok: true,
        truncated: true,
        text: text.slice(0, PLUGIN_TOOL_MAX_CHARS),
        note: `插件结果过长（${text.length} 字符），只保留了前 ${PLUGIN_TOOL_MAX_CHARS} 字符`,
      };
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 装载一个已安装的插件。
 *
 * ⚠️ 装载失败**不抛**：一个坏插件不该让整个应用起不来。
 * 失败原因进 `problems`，由调用方决定怎么显示。
 *
 * @param plugin 台账里的一条
 * @returns 装载结果（可能带 problems、也可能什么都没有）
 */
export async function loadPlugin(plugin: InstalledPlugin): Promise<LoadedPlugin> {
  const empty: LoadedPlugin = {
    name: plugin.name,
    version: plugin.version,
    dir: plugin.dir,
    entries: [],
    hooks: {},
    withheld: [],
    problems: [],
  };
  if (!existsSync(plugin.dir)) return { ...empty, problems: ["插件目录不在了"] };

  /*
   * ⭐ **先比对清单**（这是权限声明能不能立住的地方）。
   *
   * 磁盘上的清单可能是插件装完之后改过的 —— 那时它要的东西
   * 已经**不是用户批准过的那一份**了。这种情况一律**不装载**，
   * 让用户重新确认一次（而不是替他决定"应该没问题"）。
   */
  const onDisk = readManifestFromDir(plugin.dir);
  if (!onDisk.raw) {
    return { ...empty, problems: [`读不到清单：${onDisk.note ?? "未知原因"}`] };
  }
  const checked = checkManifest(onDisk.raw);
  if (!checked.ok) return { ...empty, problems: [`磁盘上的清单不合法：${checked.errors.join("；")}`] };
  /*
   * 兼容门（V6-3d）：安装时已经判过一次，装载时**再判一次**——
   * 宿主可能升级/降级过，或者这个插件是别的版本装上来的。
   */
  const incompatible = engineIncompatibility(checked.manifest.engines.ding, PRODUCT_VERSION);
  if (incompatible) return { ...empty, problems: [incompatible] };
  const drift = manifestDrifted(plugin.manifest, checked.manifest);
  if (drift) {
    return { ...empty, problems: [`它在安装之后被改过，已拒绝装载：${drift}。请卸载后重新安装并确认权限`] };
  }

  /** 授权与装载都以**批准时那份快照**为准（磁盘那份只用来比对）。 */
  const approved = plugin.manifest;
  const caps = grantedCapabilities(approved, plugin.granted);

  const entryFile = path.join(plugin.dir, approved.main ?? "index.mjs");
  if (!existsSync(entryFile)) return { ...empty, withheld: caps.withheld, problems: [`入口文件 ${approved.main ?? "index.mjs"} 不在了`] };

  /*
   * ⭐ **隔离装载（G18）**：插件代码在独立 Worker 里跑，不在主进程。
   *
   * 之前这里是 `loadModule()` 直接 import —— 插件与应用同进程、同权限：
   * 一个死循环能卡死界面，一个未捕获异常能带崩应用，`fs`/`child_process` 随便用。
   * 现在：加载、跑工具、跑钩子全在 worker 里；超时直接 terminate。
   * 文件/子进程边界由 Node 权限模型尽力强制（见 `pluginWorker.ts` 的如实说明）。
   */
  const started = await startIsolatedPlugin({
    dir: plugin.dir,
    entryUrl: pathToFileURL(entryFile).href,
    allowWrite: plugin.granted.includes("fs:write"),
    allowExec: plugin.granted.includes("exec"),
  });
  if (!started.ok) {
    return { ...empty, withheld: caps.withheld, problems: [`隔离进程没能起来：${started.error}`] };
  }
  const isolated = started.plugin;
  workers.set(plugin.name, isolated);

  const problems: string[] = [];
  const entries: ToolEntry[] = [];

  /*
   * ── 工具：声明与实现必须一致 ──
   *
   * 三种情况分别处理，都不静默：
   * · 声明了 + 导出了 → 接上；
   * · 声明了 + 没导出 → **报出来**（用户以为有这个能力，其实没有）；
   * · 导出了 + 没声明 → **不接**（未声明的能力不予注入），并报出来。
   */
  const declaredTools = new Set(approved.tools ?? []);
  const exportedTools = Object.keys(isolated.tools);
  if (caps.tools) {
    for (const tool of declaredTools) {
      const def = isolated.tools[tool];
      if (!def) {
        problems.push(`清单声明了工具 ${tool}，但代码里没有导出它`);
        continue;
      }
      const full = pluginToolName(plugin.name, tool);
      /* 调用一律过隔离进程（外层的超时是第二道保险） */
      runners.set(full, (input) => isolated.run(tool, input, PLUGIN_TOOL_TIMEOUT_MS));
      entries.push({
        name: full,
        source: "plugin",
        description: def.description ? def.description : `${plugin.name} 提供的 ${tool}`,
        /*
         * 插件给的是**纯 JSON Schema**（它不该依赖我们的 zod 版本）—— 与 MCP 那条同一个口径。
         *
         * ⚠️ 必须用 `jsonSchema()` 包一层：直接把这个普通对象交给 `tool({ inputSchema })`，
         * AI SDK 会把它当 schema 函数去调，然后在**真正建工具集时**报
         * `schema is not a function` —— 单测只查了条目的形状，是 CLI 真跑一轮才露出来的。
         */
        inputSchema: jsonSchema(normalizeSchema(def.inputSchema)),
      });
    }
    for (const exported of exportedTools) {
      if (!declaredTools.has(exported)) problems.push(`代码导出了工具 ${exported}，但清单里没声明它 —— 按"未声明不注入"处理`);
    }
  } else if (exportedTools.length) {
    problems.push(`导出了 ${exportedTools.length} 个工具，但没有 \`tools:register\` 权限（未批准或不申请）—— 一个都没接上`);
  }

  /*
   * ── 钩子：同理，声明之外的**不调用** ──
   */
  const declaredHooks = new Set(approved.hooks ?? []);
  const hooks: Partial<Record<HookName, (payload: unknown) => unknown>> = {};
  if (caps.hooks) {
    for (const hook of declaredHooks) {
      if (!isolated.hooks.includes(hook)) {
        problems.push(`清单声明了钩子 ${hook}，但代码里没有导出它`);
        continue;
      }
      hooks[hook] = (payload) => isolated.hook(hook, payload, PLUGIN_HOOK_TIMEOUT_MS);
    }
    for (const exported of isolated.hooks) {
      if (!declaredHooks.has(exported as HookName)) {
        problems.push(`代码导出了钩子 ${exported}，但清单里没声明它 —— 不会被调用`);
      }
    }
  } else if (isolated.hooks.length) {
    problems.push("导出了钩子，但没有 `hooks:register` 权限 —— 一个都不会被调用");
  }

  return {
    name: plugin.name,
    version: plugin.version,
    dir: plugin.dir,
    entries,
    hooks,
    withheld: caps.withheld,
    problems,
    isolation: isolated.isolation,
  };
}

/**
 * 装载台账里**全部开着**的插件（每次启动一次；切换开关后重新调）。
 *
 * @param installed 台账里的条目
 * @returns 装载结果（顺序与入参一致）
 */
export async function loadEnabledPlugins(installed: readonly InstalledPlugin[]): Promise<LoadedPlugin[]> {
  runners.clear();
  /* 重装载前先关掉上一批隔离进程（不然每切一次开关就多几个 worker 挂着） */
  for (const w of workers.values()) w.close();
  workers.clear();
  const out: LoadedPlugin[] = [];
  /*
   * 依赖门（L04）：依赖没装/关着/版本不符 → **不装载**，但把原因放进
   * `problems` 让界面与 `plugins list` 说出来。静默少一个插件比报错更坏。
   */
  const facts = installed.map((p) => ({ name: p.name, version: p.version, enabled: p.enabled }));
  for (const plugin of installed) {
    if (!plugin.enabled) continue;
    const missing = dependencyProblems(plugin.manifest, facts);
    if (missing.length) {
      out.push({
        name: plugin.name,
        version: plugin.version,
        dir: plugin.dir,
        entries: [],
        hooks: {},
        withheld: [],
        problems: missing.map((one) => `依赖未满足，已跳过装载：${one}`),
      });
      continue;
    }
    out.push(await loadPlugin(plugin));
  }
  loaded = out;
  return out;
}

/** 清空装载状态（测试与"关掉全部插件"用）。 */
export function resetPlugins(): void {
  runners.clear();
  for (const w of workers.values()) w.close();
  workers.clear();
  loaded = [];
}

/**
 * 跑一个生命周期钩子（**只看不改**）。
 *
 * ⚠️ 三条都要做到：
 * 1. **不认识这个点就直接返回**（插件声明了没用过的点也不算错）；
 * 2. **一个钩子抛错不影响别的钩子**，也不影响这一轮 —— 插件的问题不该变成用户的故障；
 * 3. **返回值一律忽略**（见文件头第 2 条边界）。
 *
 * @param hook 生命周期点
 * @param payload 这一点的载荷（形状由各点自己定）
 */
export async function runHooks(hook: HookName, payload: unknown): Promise<void> {
  for (const plugin of loaded) {
    const fn = plugin.hooks[hook];
    if (!fn) continue;
    try {
      await fn(payload);
    } catch (error) {
      // 如实打出来，但不抛：插件坏了不该拖垮这一轮
      console.error(`[plugin] ${plugin.name} 的 ${hook} 钩子抛错：`, error instanceof Error ? error.message : error);
    }
  }
}

/**
 * 把这一份实现接到内核的钩子端口上（V5-4 4.1）。
 *
 * Node 侧的宿主（CLI / 桌面）在 `createEngine` 时注入它；最小嵌入面
 * （`ding-engine-core`）不注入 —— 那时内核用 `noopHooks`，
 * "没装插件"与"没有钩子能力"在那里是同一件事。
 */
export const pluginHooks: HooksPort = { run: runHooks };
