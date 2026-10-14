#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEngine, type Engine, type EngineRunRequest } from "../../engine/index";
import { cliSessionId, logLine, splitTurns, type LogRecord } from "../../engine/core/events";
import { formatTotal, ledgerOf, rollup, type LedgerEntry } from "../../engine/core/ledger";
import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { snapshotOf, type Snapshot } from "../../engine/core/snapshot";
import type { ToolExecutor } from "../../engine/ports/executor";
import { buildToolSet, createToolRegistry } from "../../engine/runtime/registry";
import { allProviders, firstAvailableProvider, getProvider } from "../../engine/runtime/providers";
import { describeBudget } from "../../engine/runtime/budget";
import { modelInfoOf } from "../../engine/runtime/models";
import { normalizeConfirmMode, type ConfirmMode } from "../../shared/ipc";
import { createCliExecutor } from "./tools";

/**
 * `ding` —— **CLI 宿主**（Phase 2）。
 *
 * ## 它是"宿主"，不是"另一个引擎"
 *
 * 这个文件里没有一行 agent 逻辑：跑一轮是 `engine.run`、投影是 `engine/core/events`、
 * 工具是 `engine/runtime/tools`。它只做三件宿主该做的事：
 *
 * 1. **把端口接上**（数据存哪、工具落到哪个目录、健康账本记不记）；
 * 2. **把结果画到终端**（用投影，不另写一份"怎么显示"）；
 * 3. **解析命令**。
 *
 * 它存在的意义，是让"桌面不是唯一宿主"这件事**已经成立**（而不是"计划要成立"）——
 * 同一份内核，换个宿主就能无头跑。
 *
 * ## 四个命令
 *
 * | 命令 | 用途 |
 * |---|---|
 * | `ding run "任务"` | 无头跑一轮（文件类工具，经与桌面**同一套**闸门） |
 * | `ding sessions` | 列会话 / 导出 JSONL（可观测性的出口） |
 * | `ding record <会话 id>` | 把一段会话录成快照（Phase 1 D6 的 fixture） |
 * | `ding replay <快照文件>` | 重放并与录下来的投影 diff（**重构零漂移**的验收器） |
 *
 * ## 一条纪律：它**不碰** Electron
 *
 * 这个文件（以及它 import 的一切）不许出现 `electron` —— 一旦出现，
 * "CLI 与桌面平权"就退化成"CLI 是桌面的一部分"。所以文件工具是从
 * `engine/runtime/tools/` 拿的，不是从 `electron/ipc/`。
 */

/** 数据目录：默认 `~/.ding`，可用 `DH_DATA_DIR` 覆盖（多份数据并行跑时用）。 */
function dataDir(): string {
  return process.env.DH_DATA_DIR?.trim() || path.join(os.homedir(), ".ding");
}

/** 授权目录：默认当前目录，`--dir` 可重复给（与桌面的"工作区授权"是同一个概念）。 */
function workspaceDirs(extra: readonly string[]): string[] {
  return (extra.length ? extra : [process.cwd()]).map((d) => path.resolve(d));
}

/**
 * CLI 登记哪些内置工具。
 *
 * ⚠️ 挑的是"这个宿主**真能执行**的"：记忆 / 定时任务 / 画布落到**桌面界面的 store** 上，
 * CLI 登记它们等于登记三个必然失败的按钮。
 */
const CLI_TOOLS = [
  "list_files",
  "read_file",
  "write_file",
  "list_dir",
  "search_files",
  "edit_file",
  "run_command",
  "spawn_agent",
] as const;

/* ────────────────────── 终端输出（走投影） ────────────────────── */

/** 工具留痕缩进（比正文退一格：读起来是"这句话底下发生的事"）。 */
const INDENT = "  ";

/**
 * 把一段记录画成人看的东西。
 *
 * ⚠️ **不另写一份"怎么显示"**：走的是内核的投影（`splitTurns`），
 * 与桌面上屏用的是同一份逻辑。这里只决定排版。
 *
 * @param records 整段会话的记录
 */
function render(records: readonly LogRecord[]): void {
  for (const chunk of splitTurns(records)) {
    const ask = [...(chunk.request?.messages ?? [])].reverse().find((m) => m.role === "user");
    if (ask) process.stdout.write(`\n\x1b[2m› ${ask.content.trim()}\x1b[0m\n\n`);
    const view = chunk.view;
    if (view.text.trim()) process.stdout.write(`${view.text.trim()}\n`);
    for (const trace of view.traces) {
      const mark = trace.pending ? "⏸" : trace.ok ? "✓" : "✗";
      process.stdout.write(`${INDENT}${mark} ${trace.line}\n`);
    }
    if (view.usage) {
      const u = view.usage;
      const has = typeof u.inputTokens === "number" || typeof u.outputTokens === "number";
      process.stdout.write(`${INDENT}\x1b[2m（用量${has ? ` ↑${u.inputTokens ?? "-"} ↓${u.outputTokens ?? "-"}` : ""}）\x1b[0m\n`);
    }
    if (view.error) process.stdout.write(`${INDENT}\x1b[31m${view.error}\x1b[0m\n`);
  }
}

/* ────────────────────── 命令行解析 ────────────────────── */

type Parsed = { command: string; args: string[]; flags: Map<string, string[]> };

/** 极简 argv 解析（不引依赖）：`--k v` / `--k=v` / `-k v` 都认，其余当位置参数。 */
function parseArgv(argv: readonly string[]): Parsed {
  const args: string[] = [];
  const flags = new Map<string, string[]>();
  const add = (key: string, value: string) => flags.set(key, [...(flags.get(key) ?? []), value]);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("-")) {
      args.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 0) {
      add(token.slice(0, eq).replace(/^-+/, ""), token.slice(eq + 1));
      continue;
    }
    const key = token.replace(/^-+/, "");
    const next = argv[i + 1];
    if (next && !next.startsWith("-")) {
      add(key, next);
      i += 1;
    } else {
      add(key, "true");
    }
  }
  return { command: args[0] ?? "help", args: args.slice(1), flags };
}

const flagAll = (p: Parsed, name: string): string[] => p.flags.get(name) ?? [];
const flag = (p: Parsed, name: string): string | undefined => flagAll(p, name).at(-1);

/* ────────────────────── 装配 ────────────────────── */

/**
 * 建一个供本次运行使用的引擎。
 *
 * ⚠️ 每一个端口都在这里**显式**给：数据在哪、工具能碰哪些目录、健康账本记不记
 * （CLI **不记**：跑一轮就退出，"下次启动时界面显示谁验证过"这件事在 CLI 里不存在）。
 *
 * 装配顺序有个环要绕：注册表要执行体、执行体要注册表（`spawn_agent` 要造子级工具集）。
 * 所以先给执行体一个**取值函数**，等注册表建好再把它填上 —— 环在装配期解开，
 * 运行期没有 null 检查。
 */
function buildEngine(dirs: readonly string[]): { engine: Engine; close: () => void } {
  const store = createSqliteSessionStore(dataDir());

  let makeTools: ((mode: ConfirmMode, depth: number, provider: string, signal?: AbortSignal) => ReturnType<typeof buildToolSet>) | null = null;
  const executor: ToolExecutor = createCliExecutor({
    dirs,
    makeTools: (mode, depth, provider, signal) => {
      if (!makeTools) throw new Error("工具集还没装配好（不应该发生）");
      return makeTools(mode, depth, provider, signal);
    },
  });

  const registry = createToolRegistry({ include: CLI_TOOLS });
  makeTools = (mode, depth, provider, signal) =>
    buildToolSet({
      registry,
      mode,
      executor,
      ctx: { mode, provider, depth, ...(signal ? { signal } : {}) },
    });

  // 引擎内部自己建注册表（带 include）—— 这里传的 `include` 与上面那份必须一致
  const engine = createEngine({ store, executor, include: CLI_TOOLS });
  return { engine, close: () => store.close() };
}

/* ────────────────────── 命令 ────────────────────── */

async function cmdRun(p: Parsed): Promise<number> {
  const task = p.args.join(" ").trim();
  if (!task) {
    process.stderr.write('用法：ding run "任务描述" [--dir <目录>] [--provider <id>] [--model <名>] [--mode <档位>]\n');
    return 2;
  }

  const dirs = workspaceDirs(flagAll(p, "dir"));
  const provider = flag(p, "provider") ?? firstAvailableProvider()?.id;
  if (!provider || !getProvider(provider)) {
    process.stderr.write(
      `没有可用的 provider。已登记的：${allProviders().map((x) => x.id).join(" / ")}\n` +
        `配置方式：设置对应环境变量（例如 DEEPSEEK_API_KEY），或写进 ~/.dsh/.credentials.yaml。\n`,
    );
    return 3;
  }

  const mode = normalizeConfirmMode(flag(p, "mode") ?? "全部允许");
  const sessionId = cliSessionId(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  const { engine, close } = buildEngine(dirs);

  process.stdout.write(
    `\x1b[2m工作区：${dirs.join(" / ")}\nprovider：${provider}　档位：${mode}　会话：${sessionId}\x1b[0m\n`,
  );

  const request: EngineRunRequest = {
    sessionId,
    provider,
    ...(flag(p, "model") ? { model: flag(p, "model") } : {}),
    system: cliSystemPrompt(dirs, mode),
    messages: [{ role: "user", content: task }],
    mode,
    useTools: true,
    maxSteps: Number(flag(p, "steps") ?? 8),
  };

  const outcome = await engine.run(request);
  render(outcome.records);
  close();

  if (!outcome.ok && !outcome.aborted) {
    process.stderr.write(`\n\x1b[31m没跑完：${outcome.error ?? "未知原因"}\x1b[0m\n`);
    return 1;
  }
  process.stdout.write(`\n\x1b[2m会话已存：${sessionId}（ding sessions 可列出，ding record ${sessionId} 可录快照）\x1b[0m\n`);
  return 0;
}

/**
 * 成本账本（`ding sessions --cost [--by day|model]`）。
 *
 * ⚠️ 账本是**从会话日志现算的**，没有第二份"用量统计"文件 ——
 * 另存一份统计迟早会与日志漂移（那是本项目的老毛病）。所以这里的数与
 * `--export` 出来的记录**必然一致**。
 */
async function cmdCost(p: Parsed): Promise<number> {
  const store = createSqliteSessionStore(dataDir());
  try {
    const kind = flag(p, "kind");
    const sessions = await store.list(kind === "chat" || kind === "task" || kind === "cli" ? { kind } : undefined);
    const entries: LedgerEntry[] = [];
    for (const summary of sessions) {
      const { records } = await store.load(summary.sessionId);
      // 只给会话维度留标题（其它维度用的是日期/模型名，不需要）
      const book = ledgerOf(records, summary.sessionId);
      for (const e of book) entries.push({ ...e });
      titles.set(summary.sessionId, summary.title || summary.sessionId);
    }

    const by = flag(p, "by");
    const dim = by === "day" || by === "model" ? by : "session";
    // 目录表从 runtime 递进来（core 的账本自己不去查表 —— 分层方向）
    const rows = rollup(entries, dim, (key) => titles.get(key) || key, modelInfoOf);
    if (p.flags.has("json")) {
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }
    if (!rows.length) {
      console.log("账本还是空的（没有任何一轮带 provider 上报的用量）。");
      return 0;
    }
    for (const row of rows) console.log(formatTotal(row));
    console.log("[2m口径：数字全部来自 provider 上报的 usage；`-` 表示 provider 没给（不是 0）。[0m");
    return 0;
  } finally {
    store.close();
  }
}

/** 会话 id → 标题（成本账本按会话汇总时给人看的那一列）。 */
const titles = new Map<string, string>();

async function cmdSessions(p: Parsed): Promise<number> {
  if (p.flags.has("cost")) return cmdCost(p);
  const store = createSqliteSessionStore(dataDir());
  try {
    const kind = flag(p, "kind");
    const list = await store.list(kind === "chat" || kind === "task" || kind === "cli" ? { kind } : undefined);

    const exportId = flag(p, "export");
    if (exportId) {
      const { records, skipped } = await store.load(exportId);
      /*
       * 用 `logLine` 而不是自己 `JSON.stringify(record)`：那一行是 `.jsonl` 的**格式定义**
       * （`parseLog` 是它的读侧），自己拼一遍就等于把这个格式写了两份 ——
       * 而迁移路径吃的正是这个格式，两份一旦不一致，"导出的文件导不回去"。
       */
      for (const record of records) process.stdout.write(logLine(record, record.seq, record.at));
      process.stderr.write(`\x1b[2m导出了 ${records.length} 条${skipped ? `（跳过 ${skipped} 条坏行）` : ""}\x1b[0m\n`);
      return 0;
    }
    if (p.flags.has("json")) {
      process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
      return 0;
    }
    if (!list.length) {
      process.stdout.write("还没有任何会话。\n");
      return 0;
    }
    for (const s of list) {
      const when = new Date(s.updatedAt).toLocaleString("zh-CN");
      const kb = `${Math.round(s.bytes / 1024)}KB`;
      process.stdout.write(`${s.sessionId.padEnd(28)} ${when.padEnd(22)} ${kb.padStart(6)}  ${s.title || "（没有标题）"}\n`);
    }
    return 0;
  } finally {
    store.close();
  }
}

async function cmdRecord(p: Parsed): Promise<number> {
  const sessionId = p.args[0];
  if (!sessionId) {
    process.stderr.write("用法：ding record <会话 id> [--out <文件>]\n（会话 id 从 ding sessions 拿）\n");
    return 2;
  }
  const store = createSqliteSessionStore(dataDir());
  const { records } = await store.load(sessionId);
  store.close();
  if (!records.length) {
    process.stderr.write(`会话 ${sessionId} 里没有记录。\n`);
    return 1;
  }
  const snap = snapshotOf(sessionId, records);
  const out = flag(p, "out") ?? path.join(dataDir(), "fixtures", `${sessionId}.json`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(snap, null, 2), "utf8");
  process.stdout.write(`已录制 ${records.length} 条记录 / ${snap.turns.length} 轮 → ${out}\n`);
  return 0;
}

async function cmdReplay(p: Parsed): Promise<number> {
  const file = p.args[0];
  if (!file) {
    process.stderr.write("用法：ding replay <快照文件>\n");
    return 2;
  }
  const fixture = JSON.parse(await fs.readFile(path.resolve(file), "utf8")) as Snapshot;
  const store = createSqliteSessionStore(dataDir());
  const engine = createEngine({ store, executor: { run: async () => ({ ok: false, error: "重放不该执行工具" }) } });
  const diff = await engine.replay(fixture);
  store.close();

  if (diff.equal) {
    process.stdout.write(`✓ 重放一致（${fixture.turns.length} 轮，diff 为零）\n`);
    return 0;
  }
  process.stderr.write(`✗ 重放有差异（${diff.differences.length} 处）：\n`);
  for (const d of diff.differences) process.stderr.write(`  - ${d}\n`);
  return 1;
}

/**
 * `ding models` —— 列 provider 与模型，并**如实**标出每个模型的上下文数据从哪来。
 *
 * ⚠️ "未登记模型"要明说：我们不知道它的上限，走的是保守默认。
 * 让人以为"这个数是模型的上限"，比不给这个数更坏（见 `engine/runtime/budget.ts`）。
 */
function cmdModels(): number {
  for (const provider of allProviders()) {
    process.stdout.write(`${provider.id.padEnd(12)} ${provider.label}  [${provider.models.join(", ")}]\n`);
    for (const model of provider.models) {
      process.stdout.write(`             · ${describeBudget(model)}\n`);
    }
  }
  return 0;
}

/** CLI 的系统提示词：只讲"你在哪、能做什么、边界在哪"。 */
function cliSystemPrompt(dirs: readonly string[], mode: ConfirmMode): string {
  return [
    "你是 Ding Harness 无头命令行宿主里的一个 agent。",
    `你能操作的目录（白名单）：${dirs.join("、")}。白名单之外的路径一律碰不到，不要试。`,
    "工具有：list_files / list_dir / read_file / write_file / edit_file / search_files / run_command / spawn_agent。",
    mode === "全部允许"
      ? "当前档位「全部允许」：写文件与跑命令**会直接执行**。动手前先想清楚，尤其是覆盖已有文件。"
      : `当前档位「${mode}」：会改东西的调用会被拦下、交给人确认（无头模式下没人点，等于办不成）。`,
    "做完就把结果说清楚：改了哪些文件、下一步是什么。不要复述工具返回的原文。",
  ].join("\n");
}

function cmdHelp(): number {
  process.stdout.write(
    [
      "ding —— Ding Harness 的命令行宿主",
      "",
      '  ding run "任务" [--dir <目录>] [--provider <id>] [--model <名>] [--mode <档位>] [--steps n]',
      "  ding sessions [--kind chat|task|cli] [--json] [--export <会话 id>]",
      "  ding sessions --cost [--by session|day|model]   # 成本账本（数字只来自 provider 上报）",
      "  ding record <会话 id> [--out <文件>]",
      "  ding replay <快照文件>",
      "  ding models",
      "",
      `数据目录：${dataDir()}（DH_DATA_DIR 可覆盖）`,
      "",
    ].join("\n"),
  );
  return 0;
}

/* ────────────────────── 入口 ────────────────────── */

const parsed = parseArgv(process.argv.slice(2));

try {
  const code =
    parsed.command === "run"
      ? await cmdRun(parsed)
      : parsed.command === "sessions"
        ? await cmdSessions(parsed)
        : parsed.command === "record"
          ? await cmdRecord(parsed)
          : parsed.command === "replay"
            ? await cmdReplay(parsed)
            : parsed.command === "models"
              ? cmdModels()
              : cmdHelp();
  process.exit(code);
} catch (error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`\x1b[31m出错了：${detail}\x1b[0m\n`);
  process.exit(1);
}
