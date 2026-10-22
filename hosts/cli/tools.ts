import type { ToolSet } from "ai";

import { SPAWN_AGENT_TOOL, SPAWN_AGENTS_TOOL, subagentPrompt } from "../../shared/agentTools";
import type { ConfirmMode } from "../../shared/ipc";
import { unknownToolNotice } from "../../engine/core/notices";
import type { ExecutorContext, ToolExecutor, ToolResult } from "../../engine/ports/executor";
import type { HealthStore } from "../../engine/ports/health";
import { runSubagent } from "../../engine/runtime/subagent";
import { runTeam } from "../../engine/runtime/team";
import { isPluginTool } from "../../engine/runtime/plugins";
import { runPluginTool } from "../../engine/runtime/pluginHost";
import {
  describeListDirResult,
  describeSearchResult,
  listDirForModel,
  nothingFoundNote,
  searchFilesForModel,
} from "../../engine/runtime/tools/searchTool";
import { AGENT_READ_MAX_BYTES, describeReadResult, readFileForModel } from "../../engine/runtime/tools/readTool";
import { readImageForModel, resolveImagePath } from "../../engine/runtime/tools/readImageTool";
import { describeWriteResult, resolveWriteTarget, writeFileForModel } from "../../engine/runtime/tools/writeTool";
import { describeEditResult, editFileForModel, statFingerprint } from "../../engine/runtime/tools/editTool";
import { expectedFingerprint, noteRead, noteWrite } from "../../engine/runtime/fileState";
import { applyPatch, parsePatch } from "../../engine/runtime/editFormats";
import { createKeyedSerialQueue } from "../../engine/runtime/serialQueue";
import { describeRunResult, runCommandForModel } from "../../engine/runtime/tools/execTool";
import { insideDirs } from "../../engine/runtime/tools/drivePaths";
import { killJob, readJob, startJob } from "../../engine/runtime/tools/jobs";
import { fetchForModel } from "../../engine/runtime/tools/webFetchTool";
import { TODO_WRITE_TOOL, describeTodoResult, normalizeTodos } from "../../engine/runtime/tools/todoTool";
import { describeFinish, validateFinish } from "../../engine/runtime/finishContract";
import { ASK_USER_TOOL, FINISH_TOOL, JOB_KILL_TOOL, JOB_OUTPUT_TOOL, WEB_FETCH_TOOL } from "../../shared/agentTools";
import { describeAskResult, normalizeAsk } from "../../engine/runtime/tools/askUserTool";

/**
 * CLI 宿主的**执行体**：把内核给的工具名落到真实文件系统上。
 *
 * ## 它与桌面那套的关系
 *
 * 桌面那份在 `electron/ipc/tools.ts`：它多出来的部分是"落到哪个 store"
 * （记忆库、画布、定时任务）—— 那些是**桌面宿主的**东西。文件类工具两边**完全一样**，
 * 因为它们本来就只吃一个"目录白名单"参数（`engine/runtime/tools/`）。
 *
 * ⚠️ 这里的返回形状与桌面那份**逐字段对齐**（`ok` / `line` / 外加各工具自己的字段）。
 * 不是抄一遍就完事：留痕那一行由 `describeToolResult` 生成，它读的就是这些字段 ——
 * 两边形状不一致时，屏幕上与终端里会看到**同一件事的两种说法**。
 *
 * ## 一条边界（如实）
 *
 * CLI 的目录白名单来自命令行 `--dir`（默认当前目录），**没有对话框授权这一步**。
 * 也就是说：`ding run --dir /` 是真的能把整台机器交出去。这是命令行工具的正常代价
 * （与 `rm -rf` 同级），但它与桌面那套"用户点过授权"的语义**不是一回事**，
 * 所以在这里明写出来，而不是让它看起来像有闸门。
 */

/** 子智能体要用的工具集（由宿主注入：它需要注册表，而注册表需要执行体）。 */
export type MakeTools = (
  mode: ConfirmMode,
  depth: number,
  provider: string,
  signal: AbortSignal | undefined,
  /** 只要这些工具（agent 白名单，Phase 7.1）。省略 = 不限制。 */
  only?: readonly string[],
) => ToolSet;

/**
 * 建一个 CLI 执行体。
 *
 * @param opts.dirs 授权目录（白名单）
 * @param opts.makeTools 造子智能体的工具集（`spawn_agent` 用）
 * @param opts.health 健康账本（沿父级传给子智能体）
 * @returns 执行体
 */
export function createCliExecutor(opts: {
  dirs: readonly string[];
  makeTools: MakeTools;
  health?: HealthStore;
  /**
   * **额外的只读目录**（U02）：工具结果落盘目录。
   *
   * 只加"能读"：模型要靠 `read_file` 回读落盘的大结果。
   * 写入仍然只认 `dirs` —— 这条边界不因为回读而放宽。
   */
  extraReadDirs?: readonly string[];
  /** 知识库目录（G15；不给 = 这个宿主没有知识库，工具会如实说） */
  knowledgeDir?: string;
  /** B-03：后台任务的日志落盘根目录（通常就是数据目录）。 */
  dataDir?: string;
}): ToolExecutor {
  const { dirs, makeTools } = opts;
  const extraReadDirs = opts.extraReadDirs ?? [];

  /**
   * **按目标路径**串行写/改（U05）。
   *
   * 模型同一轮里连发 `write_file a` + `edit_file a` 时，两边读到同一份旧内容，
   * 后落盘的把先落盘的盖掉（与 P42 同一类，只是这次按文件分）。
   * 只锁同一个路径：改十个不同文件仍然并行。
   */
  const serializePathWrite = createKeyedSerialQueue();

  /** 逐个工具的实现（键就是 `AGENT_TOOLS` 里的名字）。 */
  const run = async (name: string, input: unknown, ctx: ExecutorContext): Promise<ToolResult> => {
    switch (name) {
      case "list_files": {
        // 没有云盘那种"驱动器"概念：就把每个授权目录的第一层列出来
        const parts: string[] = [];
        for (const dir of dirs) {
          const got = await listDirForModel({ path: dir, depth: 1 }, dirs);
          parts.push(got.ok ? `${dir}\n${got.entries.join("\n")}` : `${dir}\n${got.error}`);
        }
        const text = parts.join("\n\n");
        return { ok: true, output: { count: dirs.length, line: `列了 ${dirs.length} 个授权目录`, text } };
      }

      case "read_image": {
        /* A-02：CLI 也能读图（路径白名单与 read_file 同一套） */
        const { path: raw } = input as { path: string };
        const resolved = await resolveImagePath(raw, dirs);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        const got = await readImageForModel(resolved.file, { modelSupportsImage: ctx.modelSupportsImage === true });
        if (!got.ok) return { ok: false, error: got.error };
        return {
          ok: true,
          output: {
            ok: true,
            line: got.line,
            path: got.path,
            bytes: got.bytes,
            ...(got.media ? { media: got.media } : {}),
            ...(got.note ? { note: got.note } : {}),
          },
        };
      }

      case "read_file": {
        const { path: raw, offset, limit } = input as { path: string; offset?: number; limit?: number };
        /*
         * U02：不分页时读**整份**（到 READ_MAX_BYTES），把"要不要落盘"交给 `applySpill` ——
         * 只读 8000 字的话，50k 行日志永远进不了落盘那条路（那是审计点名的缺陷）。
         * 分页时仍然按模型单次上限切（模型就是要那一小段）。
         */
        const paged = offset !== undefined || limit !== undefined;
        const result = await readFileForModel(raw, dirs, {
          ...(paged ? {} : { maxChars: AGENT_READ_MAX_BYTES, maxBytes: AGENT_READ_MAX_BYTES }),
          extraReadDirs,
          page: { offset, limit },
        });
        if (result.ok) noteRead(ctx.sessionId, result.path, result.fingerprint);
        return {
          ok: result.ok,
          output: {
            ok: result.ok,
            line: describeReadResult(result, raw),
            ...(result.ok
              ? {
                  text: result.text,
                  chars: result.chars,
                  truncated: result.truncated,
                  ...(result.fromLine === undefined ? {} : { fromLine: result.fromLine }),
                  ...(result.totalLines === undefined ? {} : { totalLines: result.totalLines }),
                }
              : { error: result.error }),
          },
          ...(result.ok ? {} : { error: result.error }),
        };
      }

      case "write_file": {
        const { path: raw, content, overwrite } = input as { path: string; content: string; overwrite?: boolean };
        const result = await serializePathWrite(raw, () => writeFileForModel(raw, content, dirs, overwrite === true));
        const output = {
          ok: result.ok,
          line: describeWriteResult(result, raw),
          ...(result.ok
            ? { path: result.path, chars: result.chars, bytes: result.bytes, created: result.created }
            : { error: result.error }),
        };
        return { ok: result.ok, output, ...(result.ok ? {} : { error: result.error }) };
      }

      case "apply_patch": {
        const { patchText } = input as { patchText: string };
        const parsed = parsePatch(patchText);
        if (!parsed.ok) {
          return {
            ok: false,
            output: { ok: false, line: `⚙ 补丁解析失败（第 ${parsed.line ?? "?"} 行）：${parsed.error}`, error: parsed.error },
            error: parsed.error,
          };
        }
        const result = await serializePathWrite("__apply_patch__", () =>
          applyPatch(opts.dirs[0] ?? process.cwd(), parsed.ops, {
            restrictToCwd: false,
            resolvePath: (p) => resolveWriteTarget(p, dirs),
          }),
        );
        return {
          ok: result.ok,
          output: {
            ok: result.ok,
            line: result.ok ? `⚙ 已应用补丁：${result.changed.join("、")}` : `⚙ 补丁未应用：${result.error ?? ""}`,
            ...(result.ok ? { changed: result.changed } : { error: result.error }),
          },
          ...(result.ok ? {} : { error: result.error }),
        };
      }

      case "edit_file": {
        const { path: raw, oldText, newText, replaceAll } = input as {
          path: string;
          oldText: string;
          newText: string;
          replaceAll?: boolean;
        };
        const resolved = resolveWriteTarget(raw, dirs);
        const expected = resolved ? expectedFingerprint(ctx.sessionId, resolved) : undefined;
        const result = await serializePathWrite(raw, () =>
          editFileForModel(raw, oldText, newText, dirs, replaceAll === true, expected),
        );
        if (result.ok) noteWrite(ctx.sessionId, result.path, await statFingerprint(result.path));
        const output = {
          ok: result.ok,
          line: describeEditResult(result, raw),
          ...(result.ok ? { path: result.path, replaced: result.replaced, atLine: result.line } : { error: result.error }),
        };
        return { ok: result.ok, output, ...(result.ok ? {} : { error: result.error }) };
      }

      case "list_dir": {
        const { path: raw, depth, pattern } = input as { path?: string; depth?: number; pattern?: string };
        const result = await listDirForModel({ ...(raw === undefined ? {} : { path: raw }), depth, pattern }, dirs);
        const output = {
          ok: result.ok,
          line: describeListDirResult(result, raw ?? "(授权目录)"),
          ...(result.ok
            ? {
                entries: result.entries.length,
                truncated: result.truncated,
                text: result.entries.length ? result.entries.join("\n") : nothingFoundNote("这个目录"),
              }
            : { error: result.error }),
        };
        return { ok: result.ok, output, ...(result.ok ? {} : { error: result.error }) };
      }

      case "search_files": {
        const { pattern, path: raw, include, literal, limit } = input as {
          pattern: string;
          path?: string;
          include?: string;
          literal?: boolean;
          limit?: number;
        };
        const result = await searchFilesForModel(
          { pattern, ...(raw === undefined ? {} : { path: raw }), include, literal, limit },
          dirs,
          ctx.signal,
        );
        const output = {
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
        return { ok: result.ok, output, ...(result.ok ? {} : { error: result.error }) };
      }

      case "knowledge_search": {
        if (!opts.knowledgeDir) {
          return { ok: false, error: "这个宿主没有配置知识库（用 `ding knowledge add` 之后再试）" };
        }
        const { query, limit } = input as { query: string; limit?: number };
        const { openKnowledgeStore } = await import("../../engine/rag/store");
        const { describeHits } = await import("../../shared/knowledgeTools");
        const store = openKnowledgeStore(opts.knowledgeDir);
        try {
          const hits = store.search(query, { limit: limit ?? 6 }).map((h) => ({ citation: h.citation ?? h.path ?? h.docId ?? "", text: h.text }));
          const got = describeHits(hits);
          return { ok: true, output: { ...got, count: hits.length } };
        } finally {
          store.close();
        }
      }

      /* P0-07：CLI 没有问题卡，把问题原样回给模型（宿主侧会打印到终端由用户回答） */
      case ASK_USER_TOOL: {
        const got = normalizeAsk(input);
        if (!got.ok) return { ok: false, output: { ok: false, line: got.error, error: got.error }, error: got.error };
        return { ok: true, output: { ok: true, line: describeAskResult(), ask: got.ask } };
      }

      case "run_command": {
        const { command, workdir, timeout, stdin, background } = input as {
          command: string;
          workdir?: string;
          timeout?: number;
          stdin?: string;
          background?: boolean;
        };
        /*
         * B-03：长任务放后台。工作目录仍走**同一套白名单**（不能在授权目录外起进程）。
         */
        if (background === true) {
          const wanted = String(workdir ?? "").trim() || dirs[0] || "";
          const cwd = wanted ? insideDirs(wanted, dirs) : null;
          if (!cwd) {
            const error = "这个工作目录不在授权范围内（只能在你授权的目录里跑命令）";
            return { ok: false, output: { ok: false, line: error, error }, error };
          }
          const started = await startJob({ command, cwd, ...(opts.dataDir ? { dataDir: opts.dataDir } : {}) });
          if (!started.ok) {
            return { ok: false, output: { ok: false, line: started.error, error: started.error }, error: started.error };
          }
          const line = `已在后台启动：${started.id}（用 job_output 轮询、job_kill 停止）`;
          return { ok: true, output: { ok: true, line, jobId: started.id, pid: started.pid ?? null } };
        }
        const result = await runCommandForModel(
          { command, ...(workdir === undefined ? {} : { workdir }), timeout, ...(stdin === undefined ? {} : { stdin }) },
          dirs,
        );
        const output = {
          ok: result.ok,
          line: describeRunResult(result, command, typeof stdin === "string" ? { stdinChars: stdin.length } : {}),
          ...(result.ok
            ? { exitCode: result.exitCode, cwd: result.cwd, truncated: result.truncated, timedOut: result.timedOut, text: result.output }
            : { error: result.error }),
        };
        return { ok: result.ok, output, ...(result.ok ? {} : { error: result.error }) };
      }

      /* B-03：后台任务的读取与停止 */
      case JOB_OUTPUT_TOOL: {
        const { jobId, tailLines } = input as { jobId: string; tailLines?: number };
        const got = readJob(jobId, tailLines);
        if (!got.ok) return { ok: false, output: { ok: false, line: got.error, error: got.error }, error: got.error };
        const state = got.job.running ? "还在跑" : `已结束（退出码 ${got.job.exitCode ?? "?"}）`;
        return {
          ok: true,
          output: {
            ok: true,
            line: `后台任务 ${got.job.id}：${state}${got.job.truncated ? "（输出已截断，只留尾部）" : ""}`,
            ...got.job,
          },
        };
      }
      case JOB_KILL_TOOL: {
        const { jobId } = input as { jobId: string };
        const got = killJob(jobId);
        if (!got.ok) return { ok: false, output: { ok: false, line: got.error, error: got.error }, error: got.error };
        return { ok: true, output: { ok: true, line: `已停止后台任务 ${jobId}`, killed: true, jobId } };
      }

      /* B-04：读网页（安全边界在 webFetchTool 里，这里只做形状转换） */
      case WEB_FETCH_TOOL: {
        const { url, maxChars } = input as { url: string; maxChars?: number };
        const got = await fetchForModel({ url, ...(maxChars === undefined ? {} : { maxChars }) });
        if (!got.ok) return { ok: false, output: { ok: false, line: got.error, error: got.error }, error: got.error };
        const head = got.title ? `「${got.title}」` : "";
        return {
          ok: true,
          output: {
            ok: true,
            line: `读了网页${head}（${got.text.length} 字${got.truncated ? "，已截断" : ""}）`,
            url: got.url,
            finalUrl: got.finalUrl,
            ...(got.title ? { title: got.title } : {}),
            text: got.text,
            truncated: got.truncated,
          },
        };
      }

      /*
       * P0-01：待办只做校验与回显。状态来源是这条 tool-result 本身 ——
       * 不需要新模式的事件；压缩只动消息，不动任务轨迹。
       */
      case TODO_WRITE_TOOL: {
        const { todos } = input as { todos?: unknown };
        const got = normalizeTodos(todos);
        if (!got.ok) return { ok: false, output: { ok: false, line: `待办未更新：${got.error}`, error: got.error }, error: got.error };
        return {
          ok: true,
          output: { ok: true, line: describeTodoResult(got.todos), todos: got.todos, count: got.todos.length },
        };
      }

      /* P0-02：完成契约（账本由主循环维护，CLI 执行体只读）。 */
      case FINISH_TOOL: {
        const got = validateFinish(input, ctx.turnEvidence);
        if (!got.ok) return { ok: false, output: { ok: false, line: got.error, error: got.error }, error: got.error };
        return { ok: true, output: { ok: true, line: describeFinish(got.finish), finished: got.finish } };
      }

      /*
       * 一支小队（Phase 7.2）：并行派几个专家，汇合回一份报告。
       * 工具白名单按每个专家的 AgentSpec 生效（研究员的工具集里**没有**写工具）。
       */
      case SPAWN_AGENTS_TOOL: {
        const { tasks } = input as { tasks: { agent: string; task: string; context?: string }[] };
        return {
          ok: true,
          output: await runTeam({
            tasks: tasks ?? [],
            provider: ctx.provider,
            ...(ctx.model ? { model: ctx.model } : {}),
            callerMode: ctx.mode,
            makeTools: (mode, depth, provider, signal, only) => makeTools(mode, depth, provider, signal, only),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            depth: ctx.depth ?? 0,
            ...(opts.health ? { health: opts.health } : {}),
            ...(ctx.onDelegation ? { onDelegation: ctx.onDelegation } : {}),
          }),
        };
      }

      case SPAWN_AGENT_TOOL: {
        const { task, context } = input as { task: string; context?: string };
        const depth = (ctx.depth ?? 0) + 1;
        const { system, user } = subagentPrompt(task, context);
        const report = await runSubagent({
          provider: ctx.provider,
          ...(ctx.model ? { model: ctx.model } : {}),
          system,
          user,
          tools: makeTools(ctx.mode, depth, ctx.provider, ctx.signal),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(opts.health ? { health: opts.health } : {}),
        });
        return { ok: true, output: report };
      }

      default:
        /*
         * 插件工具（Phase 8.3）：名字带前缀，运行时按前缀分流（与 MCP 同一条思路）。
         */
        if (isPluginTool(name)) {
          try {
            return { ok: true, output: await runPluginTool(name, input) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        }
        // 未知工具：回一句"没有这个工具"，而不是抛异常（口径同 unknownToolNotice）
        return { ok: false, error: unknownToolNotice(name) };
    }
  };

  return { run };
}
