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
  APPLY_PATCH_TOOL,
  SCHEDULE_LIST_TOOL,
  SEARCH_FILES_TOOL,
  SPAWN_AGENT_TOOL,
  subagentPrompt,
  WRITE_FILE_TOOL,
} from "../../shared/agentTools";
import { COMPUTER_CLICK_TOOL, COMPUTER_KEY_TOOL, COMPUTER_SCREENSHOT_TOOL, COMPUTER_TYPE_TOOL } from "../../shared/computerTools";
import type { ConfirmMode } from "../../shared/ipc";
import { unknownToolNotice } from "../../engine/core/notices";
import { buildToolSet, createToolRegistry, type ToolEntryInput } from "../../engine/runtime/registry";
import { applyPatch, parsePatch } from "../../engine/runtime/editFormats";
import { parseSandboxMode, writeEffectAllowed } from "../../engine/adapters/sandbox";
import { expectedFingerprint, noteRead, noteWrite } from "../../engine/runtime/fileState";
import type { ToolInfoWire } from "../../shared/ipc";
/* 插件工具从 pluginHost 直接来（registry 不再转手 re-export —— V5-4 4.1 把 IO 移出最小面） */
import { pluginToolEntries } from "../../engine/runtime/pluginHost";

export { pluginToolEntries };
import type { ToolExecutor } from "../../engine/ports/executor";
import { formatFileList } from "../../shared/fileList";
import { addMemory, MEMORY_MAX } from "../../shared/memory";
import { describeNextRun, makeJob, REPEAT_LABEL, validateJob, type RepeatType } from "../../shared/schedule";
import { readMemory, writeMemory } from "./memoryStore";
import { broadcastScheduleChanged, loadJobs, saveJobs } from "./scheduleStore";
import { sendCanvasCommand } from "./canvas";
import { AGENT_READ_MAX_BYTES, describeReadResult, readFileForModel } from "../../engine/runtime/tools/readTool";
import { describeWriteResult, resolveWriteTarget, writeFileForModel } from "../../engine/runtime/tools/writeTool";
import { statFingerprint } from "../../engine/runtime/tools/editTool";
import { describeEditResult, editFileForModel } from "../../engine/runtime/tools/editTool";
import { describeRunResult, runCommandForModel } from "../../engine/runtime/tools/execTool";
import { nothingFoundNote } from "../../engine/runtime/tools/searchTool";
import { createSerialQueue, createKeyedSerialQueue } from "../../engine/runtime/serialQueue";
import { callMcpTool, mcpToolBindings } from "./mcpStore";
import { describeListDirResult, describeSearchResult, listDirForModel, searchFilesForModel } from "../../engine/runtime/tools/searchTool";
import { listDrive, ownedDirs } from "./driveStore";
import { runSubagent } from "../../engine/runtime/subagent";
import { runTeam } from "../../engine/runtime/team";
import { isPluginTool } from "../../engine/runtime/plugins";
import { runPluginTool } from "../../engine/runtime/pluginHost";
import { runComputerAction } from "./computer";
import {
  BROWSER_CLICK_TOOL,
  BROWSER_OPEN_TOOL,
  BROWSER_SCREENSHOT_TOOL,
  BROWSER_SCROLL_TOOL,
  BROWSER_SNAPSHOT_TOOL,
  BROWSER_TYPE_TOOL,
} from "../../shared/browserTools";
import { browserClick, browserOpen, browserScreenshot, browserScroll, browserSnapshot, browserType, describeSnapshot } from "./browserHost";
import { evaluateRules } from "../../engine/core/permissionRules";
import { readComputerState } from "./computer";
import { actOnUiaElement, listUiaWindows, snapshotUiaWindow, uiaSupported } from "./uia";
import { describeUiaSnapshot } from "../../shared/uia";
import { COMPUTER_ELEMENTS_TOOL, COMPUTER_INVOKE_TOOL, COMPUTER_WINDOWS_TOOL } from "../../shared/uiaTools";
import { parseUiaAction, parseUiaRef } from "../../shared/uia";
import type { ComputerKey } from "../../shared/computer";
import { app } from "electron";
import { createFileSpillStore } from "../../engine/adapters/spillStore";
import { currentPermissionRules } from "./appSettings";
import { KNOWLEDGE_SEARCH_TOOL } from "../../shared/knowledgeTools";

/**
 * 工具结果落盘目录（U02）：`<userData>/tool-results`。
 *
 * ⚠️ 用**函数**而不是模块级常量：`app.getPath("userData")` 在打包前后不同，
 * 而模块被 import 的时刻早于 `app.whenReady()`。
 */
let spillCache: ReturnType<typeof createFileSpillStore> | null = null;
function spillStore(): ReturnType<typeof createFileSpillStore> {
  if (!spillCache) spillCache = createFileSpillStore(app.getPath("userData"));
  return spillCache;
}

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
 * **读-改-写要排队**（2026-10-16，审计 P42）。
 *
 * 记忆与定时任务都是"读出整份 → 改 → 写回整份"的形状。两次调用**并发**时
 * （模型在一轮里连发两条 `memory_save`、或按下允许时正好又有一轮在跑），
 * 两边读到的是同一份旧快照，后写的把先写的整份盖掉 —— **丢一条，而且不报错**。
 *
 * 队列本体抽在 `engine/runtime/serialQueue.ts`（那里有单测钉"两段不交错"）——
 * 本文件只把它接到这两条路上。
 *
 * 注意它只串行化**本进程内**的这几条路：外部进程同时改同一份文件不在此列
 * （那是 jsonStore/后端该管的事，不在这里假装解决）。
 */
const serializeWrite = createSerialQueue();

/**
 * **按目标路径**串行写/改（U05，2026-10-18）。
 *
 * 上一轮只把「记忆 / 定时任务」的整份读改写排了队；文件写没排 ——
 * 模型在同一轮里连发 `write_file a.txt` + `edit_file a.txt` 时，两边读到的是同一份
 * 旧内容，后落盘的把先落盘的改动盖掉，**而且不报错**。
 *
 * 只锁**同一个路径**：改十个不同文件仍然并行（全局队列会让重构变成十次串行磁盘往返）。
 */
const serializePathWrite = createKeyedSerialQueue();

/**
 * F2：沙箱模式对写文件的**效果检查**（read-only 一律拒；workspace-write 只允许工作区内）。
 * 缺省模式是 danger-full-access —— 与以前行为一致。
 */
function sandboxWriteError(target: string): string | null {
  const mode = parseSandboxMode(process.env.DING_SANDBOX_MODE);
  const root = ownedDirs()[0] ?? process.cwd();
  const got = writeEffectAllowed(mode, root, target);
  return got.ok ? null : got.error;
}

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
 * ⚠️ 读与写之间**不能有别的写插进来**：整段排在 `serializeWrite` 里（见上）。
 *
 * @param text 要记住的内容
 * @returns 给模型看的结果（含当前条数，方便它判断要不要继续）
 */
function saveToMemory(text: string): Promise<{ ok: boolean; count: number; note?: string }> {
  return serializeWrite(async () => {
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
  });
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
    const { title, prompt, repeat, customMinutes, atHour, atMinute } = input as {
      title: string;
      prompt: string;
      repeat: RepeatType;
      customMinutes?: number;
      /** 钟点（Phase 16）：模型说"每天早上 8 点"时填这两个。 */
      atHour?: number;
      atMinute?: number;
    };
    const now = Date.now();
    const job = makeJob(
      `job_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      title,
      prompt,
      repeat,
      now,
      customMinutes,
      atHour,
      atMinute,
    );
    const bad = validateJob(job);
    if (bad) return { ok: false, error: bad };

    /*
     * ⚠️ 读出整份列表、追加、再整份写回 —— 三步必须**排队**（审计 P42 的另一半，
     * 见上面 `serializeWrite`）：两条 `schedule_create` 并发时后写的会盖掉先写的。
     */
    const saved = await serializeWrite(async () => {
      const jobs = await loadJobs();
      const ok = await saveJobs([...jobs, job]);
      return { ok, count: jobs.length + 1 };
    });
    if (!saved.ok) return { ok: false, error: "写盘失败" };
    broadcastScheduleChanged();
    return {
      count: saved.count,
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
  [READ_FILE_TOOL]: async (input, env) => {
    const { path, offset, limit } = input as { path: string; offset?: number; limit?: number };
    /* U02：不分页读整份（到 READ_MAX_BYTES），让 `applySpill` 决定落盘与回注 */
    const paged = offset !== undefined || limit !== undefined;
    const result = await readFileForModel(path, ownedDirs(), {
      ...(paged ? {} : { maxChars: AGENT_READ_MAX_BYTES, maxBytes: AGENT_READ_MAX_BYTES }),
      extraReadDirs: [spillStore().dir],
      page: { offset, limit },
    });
    if (result.ok) noteRead(env.sessionId, result.path, result.fingerprint);
    return {
      ok: result.ok,
      line: describeReadResult(result, path),
      ...(result.ok
        ? {
            text: result.text,
            chars: result.chars,
            truncated: result.truncated,
            ...(result.fromLine === undefined ? {} : { fromLine: result.fromLine }),
            ...(result.totalLines === undefined ? {} : { totalLines: result.totalLines }),
          }
        : { error: result.error }),
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
    const result = await serializePathWrite(path, () => writeFileForModel(path, content, ownedDirs(), overwrite === true));
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

  [SEARCH_FILES_TOOL]: async (input, env) => {
    const { pattern, path, include, literal, limit } = input as {
      pattern: string;
      path?: string;
      include?: string;
      literal?: boolean;
      limit?: number;
    };
    const result = await searchFilesForModel({ pattern, path, include, literal, limit }, ownedDirs(), env.signal);
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

  [APPLY_PATCH_TOOL]: async (input) => {
    const { patchText } = input as { patchText: string };
    const parsed = parsePatch(patchText);
    if (!parsed.ok) {
      return { ok: false, line: `⚙ 补丁解析失败（第 ${parsed.line ?? "?"} 行）：${parsed.error}`, error: parsed.error };
    }
    for (const op of parsed.ops) {
      const target = resolveWriteTarget(op.path, ownedDirs());
      const denied = target ? sandboxWriteError(target) : null;
      if (denied) return { ok: false, line: `⚙ 补丁未应用：${denied}`, error: denied };
    }
    const result = await serializePathWrite("__apply_patch__", () =>
      applyPatch(process.cwd(), parsed.ops, {
        restrictToCwd: false,
        resolvePath: (p) => resolveWriteTarget(p, ownedDirs()),
      }),
    );
    return {
      ok: result.ok,
      line: result.ok ? `⚙ 已应用补丁：${result.changed.join("、")}` : `⚙ 补丁未应用：${result.error ?? ""}`,
      ...(result.ok ? { changed: result.changed } : { error: result.error }),
    };
  },

  [EDIT_FILE_TOOL]: async (input, env) => {
    const { path, oldText, newText, replaceAll } = input as {
      path: string;
      oldText: string;
      newText: string;
      replaceAll?: boolean;
    };
    const resolved = resolveWriteTarget(path, ownedDirs());
    const denied = resolved ? sandboxWriteError(resolved) : null;
    if (denied) return { ok: false, line: `⚙ 改不了：${denied}`, error: denied };
    const expected = resolved ? expectedFingerprint(env.sessionId, resolved) : undefined;
    const result = await serializePathWrite(path, () =>
      editFileForModel(path, oldText, newText, ownedDirs(), replaceAll === true, expected),
    );
    if (result.ok) noteWrite(env.sessionId, result.path, await statFingerprint(result.path));
    return {
      ok: result.ok,
      line: describeEditResult(result, path),
      /* ⚠️ 字段名不能叫 `line`：那是留痕那一行用的键，重名会被静默覆盖 */
      ...(result.ok ? { path: result.path, replaced: result.replaced, atLine: result.line } : { error: result.error }),
    };
  },

  /*
   * Computer Use（V6-2n）：工具那条路已经过**工具闸门**（策略表里是 write，按需确认会停下来问），
   * 这里只再检查一次"用户是否授权了电脑操作"（默认关）。
   */
  [COMPUTER_SCREENSHOT_TOOL]: async () => {
    const got = await runComputerAction({ kind: "screenshot" }, { requireEnabled: true, approvedBy: "tool-gate" });
    return got.ok
      ? { ok: true, line: got.detail, ...(got.path ? { path: got.path } : {}), ...(got.width ? { width: got.width, height: got.height } : {}) }
      : { ok: false, error: got.error };
  },
  [COMPUTER_CLICK_TOOL]: async (input) => {
    const { x, y, button } = input as { x: number; y: number; button?: "left" | "right" };
    const got = await runComputerAction({ kind: "click", x, y, ...(button ? { button } : {}) }, { requireEnabled: true, approvedBy: "tool-gate" });
    return got.ok ? { ok: true, line: got.detail } : { ok: false, error: got.error };
  },
  [COMPUTER_TYPE_TOOL]: async (input) => {
    const { text } = input as { text: string };
    const got = await runComputerAction({ kind: "type", text }, { requireEnabled: true, approvedBy: "tool-gate" });
    return got.ok ? { ok: true, line: got.detail } : { ok: false, error: got.error };
  },
  [COMPUTER_KEY_TOOL]: async (input) => {
    const { key } = input as { key: ComputerKey };
    const got = await runComputerAction({ kind: "key", key }, { requireEnabled: true, approvedBy: "tool-gate" });
    return got.ok ? { ok: true, line: got.detail } : { ok: false, error: got.error };
  },

  /*
   * 元素版 Computer Use（G05）：枚举是只读，执行动作要再过一道"电脑操作已授权"。
   */
  [COMPUTER_WINDOWS_TOOL]: async () => {
    if (!readComputerState().enabled) return { ok: false, error: "电脑操作没有授权：先在「权限矩阵」页打开（默认关闭）" };
    if (!uiaSupported()) return { ok: false, error: "元素定位目前只实现了 Windows" };
    const wins = listUiaWindows();
    return {
      ok: true,
      line: `找到 ${wins.length} 个窗口`,
      count: wins.length,
      text: wins.length ? wins.map((w) => w.name + " " + w.process).join(String.fromCharCode(10)) : "（没有可操作窗口）",
    };
  },
  [COMPUTER_ELEMENTS_TOOL]: async (input) => {
    if (!readComputerState().enabled) return { ok: false, error: "电脑操作没有授权：先在「权限矩阵」页打开（默认关闭）" };
    const { window: win, max } = input as { window?: string; max?: number };
    const got = snapshotUiaWindow(win, max ?? 200);
    if (!got.ok) return { ok: false, error: got.error };
    return {
      ok: true,
      line: `取了「${got.value.window}」的元素树（${got.value.elements.length} 个元素${got.value.truncated ? "，已截断" : ""}）`,
      window: got.value.window,
      elements: got.value.elements.length,
      text: describeUiaSnapshot(got.value),
    };
  },
  [COMPUTER_INVOKE_TOOL]: async (input) => {
    if (!readComputerState().enabled) return { ok: false, error: "电脑操作没有授权：先在「权限矩阵」页打开（默认关闭）" };
    const { window: win, ref, action, text } = input as { window?: string; ref: string; action: string; text?: string };
    const index = parseUiaRef(ref);
    if (index === null) return { ok: false, error: `ref 格式不对（要形如 #3）：${ref}` };
    const act = parseUiaAction(action);
    if (!act) return { ok: false, error: `不认识的动作：${action}` };
    const got = actOnUiaElement(win, index, act, text ?? "");
    if (!got.ok) return { ok: false, error: got.error };
    return { ok: true, line: `${act} 「${got.name}」：${got.detail}` };
  },

  /*
   * 浏览器 agent（G04）。闸门已经判过"要不要问"；
   * 这里只多一件事：**外网地址要有一条显式 allow 规则**才放行（默认只开本机）。
   */
  [BROWSER_OPEN_TOOL]: async (input) => {
    const { url } = input as { url: string };
    const rules = currentPermissionRules();
    const host = (() => {
      try {
        return new URL(url).host.toLowerCase();
      } catch {
        return "";
      }
    })();
    /*
     * 判"放行"用的是 `evaluateRules`（与闸门同一份实现），不是在这里另写一段匹配：
     * 两处各判一套，迟早会出现"审批卡片说允许、执行体说不行"。
     */
    const allowed = host ? evaluateRules(rules, "browser_open", host) === "allow" : false;
    const got = await browserOpen(url, { allowExternal: allowed });
    if (!got.ok) return { ok: false, error: got.error };
    return { ok: true, line: `打开了「${got.value.title || got.value.url}」`, url: got.value.url, title: got.value.title };
  },
  [BROWSER_SNAPSHOT_TOOL]: async (input) => {
    const { maxElements, maxNodes } = input as { maxElements?: number; maxNodes?: number };
    const got = await browserSnapshot({ ...(maxElements === undefined ? {} : { maxElements }), ...(maxNodes === undefined ? {} : { maxNodes }) });
    if (!got.ok) return { ok: false, error: got.error };
    const s = got.value;
    return {
      ok: true,
      line: `取了快照（${s.elements.length} 个可交互元素${s.truncated.elements || s.truncated.nodes ? "，已截断" : ""}）`,
      url: s.url,
      title: s.title,
      elements: s.elements.length,
      text: describeSnapshot(s),
    };
  },
  [BROWSER_CLICK_TOOL]: async (input) => {
    const { ref } = input as { ref: string };
    const got = await browserClick(ref);
    return got.ok ? { ok: true, line: `点了 ${ref}「${got.value.name}」` } : { ok: false, error: got.error };
  },
  [BROWSER_TYPE_TOOL]: async (input) => {
    const { ref, text, submit } = input as { ref: string; text: string; submit?: boolean };
    const got = await browserType(ref, text, submit === true);
    return got.ok
      ? { ok: true, line: `在 ${ref} 输入了 ${got.value.chars} 字${submit ? "并回车" : ""}` }
      : { ok: false, error: got.error };
  },
  [BROWSER_SCROLL_TOOL]: async (input) => {
    const { deltaY } = input as { deltaY: number };
    const got = await browserScroll(deltaY);
    return got.ok ? { ok: true, line: `滚动到 y=${got.value.y}` } : { ok: false, error: got.error };
  },
  [BROWSER_SCREENSHOT_TOOL]: async () => {
    const got = await browserScreenshot();
    if (!got.ok) return { ok: false, error: got.error };
    return {
      ok: true,
      line: `截图 ${got.value.width}×${got.value.height}`,
      path: got.value.path,
      width: got.value.width,
      height: got.value.height,
    };
  },

  [RUN_COMMAND_TOOL]: async (input, env) => {
    const { command, workdir, timeout } = input as { command: string; workdir?: string; timeout?: number };
    /*
     * ⭐ **把中止信号传下去**（2026-10-16，审计 P35）。
     *
     * 在此之前这一行是 `runCommandForModel({command, workdir, timeout}, ownedDirs())` ——
     * 于是用户点「停止」时，`run_command` 起的那条命令**连它的孙进程一起继续跑**，
     * 一直跑到 30 分钟超时（`timeout:0` 时更久）。同一份信号 `env.signal` 早就
     * 传给了 `search_files` 与子智能体，只有跑命令这一条漏了 —— 而它恰恰是
     * "把 shell 交出去"的那条，最需要有刹车。
     */
    const result = await runCommandForModel(
      { command, workdir, timeout, ...(env.signal ? { signal: env.signal } : {}) },
      ownedDirs(),
    );
    return {
      ok: result.ok,
      line: describeRunResult(result, command),
      ...(result.ok
        ? {
            exitCode: result.exitCode,
            cwd: result.cwd,
            truncated: result.truncated,
            timedOut: result.timedOut,
            ...(result.aborted ? { aborted: true } : {}),
            text: result.output,
          }
        : { error: result.error }),
    };
  },

  /**
   * 本地知识库检索（G15）。
   *
   * 这个工具声明早就在 `AGENT_TOOLS` 里（`shared/knowledgeTools.ts`），但桌面执行体
   * **没有对应分支** —— 模型调到它只会拿到"没有这个工具"。CLI 那条早就接上了
   * （`ding knowledge`），桌面的知识库面板与这里用同一个库文件。
   */
  [KNOWLEDGE_SEARCH_TOOL]: async (input) => {
    const { query, limit } = input as { query: string; limit?: number };
    const { openKnowledgeStore } = await import("../../engine/rag/store");
    const { describeHits } = await import("../../shared/knowledgeTools");
    const store = openKnowledgeStore(app.getPath("userData"));
    try {
      const hits = store.search(query, { limit: limit ?? 6 }).map((h) => ({
        citation: h.citation ?? h.path ?? h.docId ?? "",
        text: h.text,
      }));
      return { ...describeHits(hits), count: hits.length };
    } finally {
      store.close();
    }
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
      ...(env.sessionId ? { sessionId: env.sessionId } : {}),
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
  /** D3：这段会话的 id（读后写校验按会话隔离）。 */
  sessionId?: string;
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
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    }),
};

/**
 * 连接器（MCP）交出来的工具 → 注册表条目。
 *
 * schema 用服务端给的 JSON Schema **直接转**（`jsonSchema()`）—— 不重新描述一遍：
 * MCP 服务端本来就是按 JSON Schema 暴露参数的，再抄一份必然漂移。
 */
export const TOOLS_CHANNEL = { list: "tools:list" } as const;

/**
 * D2：工具面板的数据源 —— **当前注册表**，不是另一份手写清单。
 * MCP 与插件工具也在里面（界面要能看到"模型到底够得着什么"）。
 */
export function toolInfoList(): ToolInfoWire[] {
  return createToolRegistry({ extra: [...mcpToolEntries(), ...pluginToolEntries()] })
    .list()
    .map((entry) => ({
      name: entry.name,
      source: entry.source,
      description: entry.description,
      readOnly: entry.readOnly,
      destructive: entry.destructive,
      concurrency: entry.concurrency,
      resultPolicy: entry.resultPolicy,
      ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
    }));
}

export function registerToolsIpc(ipc: Pick<typeof import("electron").ipcMain, "handle">): void {
  ipc.handle(TOOLS_CHANNEL.list, () => toolInfoList());
}

export function mcpToolEntries(): ToolEntryInput[] {
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
      ...(env.sessionId ? { sessionId: env.sessionId } : {}),
    },
    /* 落盘（U02）：超限结果写进 userData，回注路径让模型能回读 */
    spill: spillStore(),
    /*
     * 权限规则（U03）：用户在审批卡片上点过「总是允许」的那些 ——
     * 从设置缓存同步读（`agentTools` 是同步装配，规则在写盘成功时已进缓存）。
     */
    ...(currentPermissionRules().length ? { rules: currentPermissionRules() } : {}),
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
  APPLY_PATCH_TOOL,
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
