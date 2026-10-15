#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { createEngine, type Engine, type EngineRunRequest } from "../../engine/index";
import { cliSessionId, logLine, splitTurns, type LogRecord } from "../../engine/core/events";
import { formatTotal, ledgerOf, rollup, type LedgerEntry } from "../../engine/core/ledger";
import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { snapshotOf, type Snapshot } from "../../engine/core/snapshot";
import { allProviders, firstAvailableProvider, getProvider } from "../../engine/runtime/providers";
import { describeBudget } from "../../engine/runtime/budget";
import { modelInfoOf } from "../../engine/runtime/models";
import { budgetOf } from "../../engine/runtime/budget";
import { CONFIRM_MODES, normalizeConfirmMode, type ConfirmMode } from "../../shared/ipc";
import { buildEngine as buildEngineIn } from "./assembly";
import { EVAL_CASES } from "../../engine/eval/cases";
import { runSuite } from "../../engine/eval/run";
import { EVAL_CATEGORIES } from "../../engine/eval/types";
import { configPaths, describeConfig, effectiveConfig, readConfig, writeConfig, type CliConfig } from "./config";
import { replPrecondition, runRepl } from "./repl";
import { flag, flagAll, parseArgv, type Parsed } from "./args";
import {
  auditLedger,
  installFromDir,
  installFromNpm,
  makePackDir,
  packNpm,
  pluginPaths,
  readLedger,
  readManifestFromDir,
  readManifestFromTarball,
  setEnabled,
  uninstall,
} from "../../engine/adapters/pluginStore";
import { loadEnabledPlugins, loadedPlugins, withheldCapabilities } from "../../engine/runtime/pluginHost";
import { ENFORCED_PERMISSIONS, PLUGIN_PERMISSIONS, checkManifest, type PluginPermission } from "../../engine/runtime/plugins";
import { AGENT_SPECS } from "../../engine/runtime/agents";

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

/** 目录表里关于这个模型的那几行（`ding models --json` 用；未登记就如实说）。 */
function budgetInfo(modelId: string): Record<string, unknown> {
  const got = budgetOf(modelId);
  return {
    registered: got.registered,
    contextWindow: got.contextWindow,
    stale: got.stale,
  };
}

/* 装配（CLI_TOOLS / buildEngine / 注册表来源）已搬到 ./assembly.ts —— 见那里的说明。 */

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
async function buildEngine(dirs: readonly string[]): Promise<{ engine: Engine; close: () => void; plugins: string[] }> {
  /*
   * 装配在 `./assembly.ts`（Phase 10 拆出来的）—— 评测器要**用同一份装配**跑，
   * 自己拼一套端口就等于绕开产品那条路。这里只负责把本宿主的数据目录传进去。
   */
  return buildEngineIn(dirs, dataDir());
}

/* ────────────────────── 命令 ────────────────────── */

/**
 * `--json`（Phase 9）：给 CI/脚本的输出模式。
 *
 * ⚠️ 它是**输出格式**开关，不是"另一种运行方式"：同一套代码路径，
 * 只把给人看的那几行换成 JSON。所以它落在**每个命令的渲染那一处**，
 * 而**判定只有这一处**（`flag(p,"json")`）—— 名字别改来改去。
 */
async function cmdRun(p: Parsed): Promise<number> {
  const task = p.args.join(" ").trim();
  if (!task) {
    process.stderr.write('用法：ding run "任务描述" [--dir <目录>] [--provider <id>] [--model <名>] [--mode <档位>]\n');
    return 2;
  }

  /*
   * 优先级：**命令行显式参数 > 环境变量 > config.json > 内置默认**
   * （见 `hosts/cli/config.ts` 的文件头 —— 三层各有各的场合：
   * CI 用环境变量、日常用配置、临时用命令行）。
   */
  const { config, note } = effectiveConfig(dataDir());
  if (note) process.stderr.write(`[配置] ${note}\n`);

  const dirs = workspaceDirs(flagAll(p, "dir").length ? flagAll(p, "dir") : (config.dirs ?? []));

  const provider = flag(p, "provider") ?? config.provider ?? firstAvailableProvider()?.id;
  if (!provider || !getProvider(provider)) {
    process.stderr.write(
      `没有可用的 provider。已登记的：${allProviders().map((x) => x.id).join(" / ")}\n` +
        `配置方式：设置对应环境变量（例如 DEEPSEEK_API_KEY），或写进 ~/.dsh/.credentials.yaml。\n`,
    );
    return 3;
  }

  const mode = normalizeConfirmMode(flag(p, "mode") ?? config.mode ?? "全部允许");
  const sessionId = cliSessionId(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  const { engine, close, plugins } = await buildEngine(dirs);
  for (const problem of plugins) process.stderr.write(`[plugin] ${problem}\n`);

  process.stdout.write(
    `\x1b[2m工作区：${dirs.join(" / ")}\nprovider：${provider}　档位：${mode}　会话：${sessionId}\x1b[0m\n`,
  );

  const request: EngineRunRequest = {
    sessionId,
    provider,
    ...((flag(p, "model") ?? config.model) ? { model: flag(p, "model") ?? config.model } : {}),
    system: cliSystemPrompt(dirs, mode),
    messages: [{ role: "user", content: task }],
    mode,
    useTools: true,
    maxSteps: Number(flag(p, "steps") ?? 8),
  };

  const outcome = await engine.run(request);
  if (p.flags.has("json")) {
    /*
     * JSON 输出给脚本用：**只把"发生过什么"结构化**，不夹一句人话。
     * 正文与留痕出自投影（与终端渲染同一份数据），所以两种输出不会对不上。
     */
    const snap = await engine.record(sessionId);
    const view = snap?.turns.at(-1)?.view;
    console.log(
      JSON.stringify(
        {
          ok: outcome.ok,
          ...(outcome.error ? { error: outcome.error } : {}),
          aborted: outcome.aborted,
          provider: outcome.provider,
          model: outcome.model,
          sessionId,
          text: view?.text ?? "",
          traces: (view?.traces ?? []).map((t) => ({ name: t.name, ok: t.ok, pending: t.pending === true, line: t.line })),
          ...(view?.usage ? { usage: view.usage } : {}),
        },
        null,
        2,
      ),
    );
  } else {
    render(outcome.records);
  }
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
function cmdModels(p: Parsed = { command: "", args: [], flags: new Map() }): number {
  if (p.flags.has("json")) {
    console.log(
      JSON.stringify(
        allProviders().map((provider) => ({
          id: provider.id,
          label: provider.label,
          protocol: provider.protocol,
          baseURL: provider.baseURL,
          models: provider.models.map((m) => ({ id: m, ...budgetInfo(m) })),
        })),
        null,
        2,
      ),
    );
    return 0;
  }
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

/**
 * `ding plugins [子命令]` —— 插件管理（Phase 8.2 / 8.4 的 CLI 那一面）。
 *
 * ⚠️ 安装要求**显式确认**（`--yes`）：`install` 会把别人的代码装进你的机器，
 * 而"权限确认"这件事在无头环境里只能靠一个明确的旗子表达 ——
 * 没有它就把权限清单打出来并**拒绝安装**（而不是替你点了"同意"）。
 */
async function cmdPlugins(p: Parsed): Promise<number> {
  const paths = pluginPaths(dataDir());
  const sub = p.args[0] ?? "list";
  const name = p.args[1];
  const ledger = () => readLedger(paths).ledger.installed;

  /*
   * 先装载一遍开着的那批 —— 因为"哪些能力被扣下了"与"装载时发现了什么问题"
   * **只有装载才知道**（不装载的话 doctor 永远说"没问题"，那正是"检查在空转"）。
   */
  await loadEnabledPlugins(ledger());
  const problems = loadedPlugins().flatMap((pl) => pl.problems.map((x) => `${pl.name}：${x}`));

  if (sub === "list") {
    const list = ledger();
    if (p.flags.has("json")) {
      console.log(JSON.stringify(list, null, 2));
      return 0;
    }
    if (!list.length) {
      console.log(`还没有装任何插件（目录：${paths.root}）`);
      console.log("装一个：ding plugins install <目录> --yes");
      return 0;
    }
    for (const item of list) {
      const granted = item.granted.length ? item.granted.join(" / ") : "无";
      console.log(`${item.name}@${item.version}　${item.enabled ? "开着" : "关着"}　权限：${granted}`);
      console.log(`    ${item.description}`);
    }
    const { missing } = auditLedger(paths);
    if (missing.length) console.error(`⚠️ 这些插件的目录不在了：${missing.join(" / ")}`);
    for (const w of withheldCapabilities()) {
      console.log(`（${w.plugin} 申请了但你没批：${w.permissions.join(" / ")}）`);
    }
    for (const problem of problems) console.log(`⚠️ ${problem}`);
    return 0;
  }

  if (sub === "install") {
    if (!name) {
      console.error("用法：ding plugins install <目录|npm:包名> [--yes] [--grant tools:register,hooks:register]");
      return 2;
    }
    /*
     * 两个渠道（Phase 8.2）：本地目录 `install <目录>`，npm 包 `install npm:<包名>`。
     *
     * ⚠️ npm 那条走**两段式**：先取包（`npm pack`）、读出清单给用户看，
     * 用户加 `--yes` 之后才真装。合成一步的话，"权限确认"就只能发生在
     * **已经下载并解开之后** —— 那不叫确认，那叫通知。
     */
    const isNpm = name.startsWith("npm:");
    const packDir = isNpm ? makePackDir() : "";
    const probe = isNpm
      ? (() => {
          const packed = packNpm(name.slice(4), packDir);
          if (!packed.ok) return { note: packed.errors.join("；") };
          return readManifestFromTarball(packed.tgz);
        })()
      : readManifestFromDir(path.resolve(name));
    if (!probe.raw) {
      console.error(`读不到清单：${probe.note ?? "未知原因"}`);
      return 1;
    }
    const checked = checkManifest(probe.raw);
    if (!checked.ok) {
      console.error("清单不合法：");
      for (const e of checked.errors) console.error(`  · ${e}`);
      return 1;
    }
    const m = checked.manifest;
    console.log(`插件 ${m.name}@${m.version}`);
    console.log(`  ${m.description}`);
    console.log(`  它申请的权限：${m.permissions.length ? m.permissions.join(" / ") : "（无）"}`);
    const enforced = m.permissions.filter((x) => ENFORCED_PERMISSIONS.includes(x));
    const declaredOnly = m.permissions.filter((x) => !ENFORCED_PERMISSIONS.includes(x));
    if (enforced.length) console.log(`  · 这几项**会真的生效**（不批就不接那根线）：${enforced.join(" / ")}`);
    if (declaredOnly.length) {
      console.log(`  · 这几项 v1 **拦不住**（插件与宿主同进程同权限）—— 是"知情"不是"限制"：${declaredOnly.join(" / ")}`);
    }

    if (!p.flags.has("yes")) {
      console.error("");
      console.error("确认之后再加 `--yes` 重跑（这一步就是权限确认：不替你点同意）。");
      return 3;
    }

    const grantArg = flag(p, "grant");
    const granted = grantArg
      ? grantArg
          .split(",")
          .map((x) => x.trim())
          .filter((x): x is PluginPermission => PLUGIN_PERMISSIONS.includes(x as PluginPermission))
      : undefined;
    const got = isNpm
      ? installFromNpm({ paths, spec: name.slice(4), ...(granted ? { granted } : {}) })
      : installFromDir({ paths, from: path.resolve(name), ...(granted ? { granted } : {}) });
    if (!got.ok) {
      console.error("装不上：");
      for (const e of got.errors) console.error(`  · ${e}`);
      return 1;
    }
    console.log("");
    console.log(`✓ 装好了：${got.plugin.name}@${got.plugin.version} → ${got.plugin.dir}`);
    return 0;
  }

  if (sub === "enable" || sub === "disable") {
    if (!name) {
      console.error(`用法：ding plugins ${sub} <名字>`);
      return 2;
    }
    const got = setEnabled(paths, name, sub === "enable");
    if (!got.ok) {
      console.error(got.note ?? "没成功");
      return 1;
    }
    console.log(`✓ ${name} 已${sub === "enable" ? "打开" : "关掉"}（下次运行生效）`);
    return 0;
  }

  if (sub === "remove") {
    if (!name) {
      console.error("用法：ding plugins remove <名字>");
      return 2;
    }
    const got = uninstall(paths, name);
    if (!got.ok) {
      console.error(got.note ?? "没成功");
      return 1;
    }
    console.log(`✓ 卸载了 ${name}（台账与它拷贝进来的那份内容都清了；你给它的源目录没动）`);
    return 0;
  }

  if (sub === "doctor") {
    const { missing } = auditLedger(paths);
    const withheld = withheldCapabilities();
    console.log(`插件目录：${paths.root}`);
    console.log(`台账：${paths.ledger}${existsSync(paths.ledger) ? "" : "（还没有）"}`);
    console.log(`装载了 ${loadedPlugins().length} 个（开着的那批）`);
    if (missing.length) console.log(`⚠️ 目录不在了：${missing.join(" / ")}`);
    for (const w of withheld) console.log(`⚠️ ${w.plugin} 申请的这几项没被批准：${w.permissions.join(" / ")}`);
    for (const problem of problems) console.log(`⚠️ ${problem}`);
    if (!missing.length && !withheld.length && !problems.length) console.log("没有发现问题。");
    return 0;
  }

  console.error(`不认识的子命令：${sub}（可用：list / install / enable / disable / remove / doctor）`);
  return 2;
}

/**
 * `ding config [--json]` / `ding config set <键> <值>` / `ding config unset <键>`
 *
 * ⚠️ 只改**这一个键**：先读回来再改再写（不是覆盖整份文件）——
 * 否则以后加一个键，旧版本一跑就把新键抹掉了。
 */
function cmdConfig(p: Parsed): number {
  const dir = dataDir();
  const sub = p.args[0] ?? "show";

  if (sub === "show") {
    const { config, note } = effectiveConfig(dir);
    if (p.flags.has("json")) {
      console.log(JSON.stringify({ dataDir: dir, ...config }, null, 2));
      return 0;
    }
    if (note) console.log(`⚠️ ${note}`);
    console.log(describeConfig(config));
    console.log("");
    console.log(`配置文件：${configPaths(dir).primary}${existsSync(configPaths(dir).primary) ? "" : "（还没有，set 一次就会建）"}`);
    console.log("改：ding config set provider deepseek ｜ ding config unset model");
    return 0;
  }

  if (sub === "set") {
    const key = p.args[1];
    const value = p.args.slice(2).join(" ").trim();
    if (!key || !value) {
      console.error("用法：ding config set <provider|model|mode|dirs> <值>（dirs 用逗号分隔）");
      return 2;
    }
    if (!["provider", "model", "mode", "dirs"].includes(key)) {
      console.error(`不认识的键：${key}（可用：provider / model / mode / dirs）`);
      return 2;
    }
    const current = readConfig(dir).config;
    const next = { ...current };
    if (key === "dirs") next.dirs = value.split(",").map((d: string) => d.trim()).filter(Boolean);
    else if (key === "mode") {
      const mode = normalizeConfirmMode(value);
      if (mode !== value) {
        console.error(`「${value}」不是有效档位。可用：${CONFIRM_MODES.join(" / ")}`);
        return 2;
      }
      next.mode = mode;
    } else if (key === "provider") next.provider = value;
    else next.model = value;

    const file = writeConfig(dir, next);
    console.log(`✓ ${key} = ${key === "dirs" ? next.dirs?.join(" / ") : value}`);
    console.log(`  写进了 ${file}`);
    return 0;
  }

  if (sub === "unset") {
    const key = p.args[1] as keyof CliConfig | undefined;
    if (!key || !["provider", "model", "mode", "dirs"].includes(key)) {
      console.error("用法：ding config unset <provider|model|mode|dirs>");
      return 2;
    }
    const current = { ...readConfig(dir).config };
    delete current[key];
    writeConfig(dir, current);
    console.log(`✓ 已清掉 ${key}（回落到默认）`);
    return 0;
  }

  console.error(`不认识的子命令：${sub}（可用：show / set / unset）`);
  return 2;
}

/** `ding agents` —— 列内置的专家（Phase 7.1 的数据化在这里可见）。 */
function cmdAgents(p: Parsed = { command: "", args: [], flags: new Map() }): number {
  if (p.flags.has("json")) {
    console.log(JSON.stringify(AGENT_SPECS.map((a) => ({ name: a.name, description: a.description, tools: a.tools ?? null, maxSteps: a.maxSteps })), null, 2));
    return 0;
  }
  for (const spec of AGENT_SPECS) {
    const tools = spec.tools ? spec.tools.join(" / ") : "（不限）";
    console.log(spec.name);
    console.log(`    ${spec.description}`);
    console.log(`    工具：${tools}　步数：${spec.maxSteps}`);
  }
  return 0;
}

/* ────────────────────── eval（Phase 10） ────────────────────── */

/**
 * 仓根。
 *
 * ⚠️ 两条路都要留：**打包后的 CLI 是 CJS**（有 `__dirname`），
 * 而 `pnpm ding` 走 tsx（ESM，没有 `__dirname` —— 用它会 ReferenceError）。
 * `typeof __dirname` 在 ESM 下不会抛（对未声明标识符取 typeof 是安全的）。
 */
function repoRoot(): string {
  /*
   * 往上找 `engine/eval/cases.ts` —— 而不是"从 cwd 上两级"或"从 __dirname 上两级"：
   * 那两条各只对一种跑法（tsx 从仓根跑 / 打包后的 dist-cli/hosts/cli），换一种就指错地方
   * （实测撞过：写基线写到了 `C:\engine\evalaseline.json`）。
   * 找标记文件对两种跑法都对。
   */
  const starts = [process.cwd(), ...(typeof __dirname === "string" ? [__dirname] : [])];
  for (const start of starts) {
    let dir = path.resolve(start);
    for (let i = 0; i < 6; i += 1) {
      if (fsSync.existsSync(path.join(dir, "engine", "eval", "cases.ts"))) return dir;
      dir = path.dirname(dir);
    }
  }
  return process.cwd();
}

/**
 * 基线落哪（**进版本库**）。
 *
 * ⚠️ 不放 `docs/`：那个目录被 `.gitignore` 排除了（内部施工笔记不入公开仓，2026-10-15 的决定）。
 * 基线必须跟着版本走 —— 它是"通过率不许往下掉"的那个参照。
 */
function evalBaselinePath(): string {
  return path.join(repoRoot(), "engine", "eval", "baseline.json");
}

/**
 * `ding eval [suite] [--json] [--update-baseline]`（Phase 10.2）。
 *
 * ## 它为什么必须离线
 *
 * 评测要**能进 CI、能天天跑**，所以一条真 provider 都不调：用例自带脚本化的模型回复
 * （`engine/eval/fakeProvider.ts` 起一个本地的 OpenAI 兼容 SSE 服务），
 * 于是被测的是**真代码路径**（真 SDK、真流解析、真工具往返、真闸门），
 * 只是"模型"那一段是确定性的。
 *
 * ## 它与 `engine/eval/eval.test.ts` 的关系
 *
 * **同一个 `runSuite`**：那条在 CI 里当门（通过率跌超 5% 即红），这条给人看报告。
 * 一个跑、一个看 —— 不会出现"CI 判的与命令行看到的不一样"。
 *
 * @param p 解析后的参数
 * @returns 退出码（有失败 = 1）
 */
async function cmdEval(p: Parsed): Promise<number> {
  const only = p.args[0];
  if (only && !EVAL_CATEGORIES.includes(only as (typeof EVAL_CATEGORIES)[number])) {
    process.stderr.write(`没有这一类评测集：${only}\n可选：${EVAL_CATEGORIES.join(" / ")}\n`);
    return 2;
  }
  const cases = only ? EVAL_CASES.filter((c) => c.category === only) : EVAL_CASES;
  if (!cases.length) {
    process.stderr.write("这一类还没有用例。\n");
    return 2;
  }

  const report = await runSuite(
    cases,
    {
      /*
       * ⚠️ 每个用例一个临时工作目录 + 一个临时数据目录：**绝不碰真实 userData**。
       * CLI 的 `ding run` 用的是真实数据目录，而评测是"可重复的检查"，
       * 写进真实目录会让下一轮的先决条件变掉（前几条用例跑的产物变成后几条的既有状态）。
       */
      makeEngine: async (workDir) => {
        const storeDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "dh-eval-store-"));
        const built = await buildEngineIn([workDir], storeDir);
        return {
          engine: built.engine,
          close: () => {
            built.close();
            fsSync.rmSync(storeDir, { recursive: true, force: true });
          },
        };
      },
      sessionPrefix: "eval",
    },
    (r, i, total) => {
      if (p.flags.has("json")) return;
      process.stdout.write(`${r.ok ? "✓" : "✗"} [${i}/${total}] ${r.id}  ${r.title}\n`);
      for (const f of r.failures) process.stdout.write(`     ${f.what}：${f.detail}\n`);
    },
  );

  if (p.flags.has("json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`\n共 ${report.total} 条，通过 ${report.passed}，失败 ${report.failed}，通过率 ${report.rate}%\n`);
    for (const [category, slot] of Object.entries(report.byCategory)) {
      process.stdout.write(`  ${category}：${slot.passed}/${slot.total}\n`);
    }
  }

  /* 基线：`--update-baseline` 落盘；否则只比对并提示（判定在单测里，这里给人看） */
  const baselineFile = evalBaselinePath();
  if (p.flags.has("update-baseline")) {
    const payload = { rate: report.rate, total: report.total, byCategory: report.byCategory, generatedAt: new Date().toISOString() };
    fsSync.writeFileSync(baselineFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
    process.stdout.write(`基线已更新：${baselineFile}\n`);
  } else if (fsSync.existsSync(baselineFile)) {
    const baseline = JSON.parse(fsSync.readFileSync(baselineFile, "utf8")) as { rate: number };
    const drop = baseline.rate - report.rate;
    if (drop > 5) process.stderr.write(`⚠️ 通过率比基线跌了 ${drop.toFixed(1)} 个百分点（${baseline.rate}% → ${report.rate}%）\n`);
  } else {
    process.stdout.write(`（还没有基线：跑 \`ding eval --update-baseline\` 落一份）\n`);
  }

  return report.failed ? 1 : 0;
}

function cmdHelp(devMode = false): number {
  process.stdout.write(
    [
      "ding —— Ding Harness 的命令行宿主",
      "",
      '  ding run "任务" [--dir <目录>] [--provider <id>] [--model <名>] [--mode <档位>] [--steps n]',
      "  ding sessions [--kind chat|task|cli] [--json] [--export <会话 id>]",
      "  ding sessions --cost [--by session|day|model]   # 成本账本（数字只来自 provider 上报）",
      "  ding eval [类别] [--json] [--update-baseline]  # 离线评测集（不烧 token，可进 CI）",
      "  ding models",
      "  ding agents                                    # 内置专家（AgentSpec）",
      "  ding plugins [list|install <目录|npm:包名> --yes|enable|disable|remove|doctor]",
      "  ding config [show|set <键> <值>|unset <键>]    # 默认 provider / 模型 / 档位 / 目录",
      "  ding --json <命令>                             # 给脚本/CI 的 JSON 输出",
      ...(devMode
        ? [
            "",
            "工程模式（--dev，验收驱动器，不属于产品表面）：",
            "  ding record <会话 id> [--out <文件>]",
            "  ding replay <快照文件>",
          ]
        : ["", "（`--dev` 会多出两个工程模式命令：record / replay —— 那是验收驱动用的。）"]),
      "",
      `数据目录：${dataDir()}（DH_DATA_DIR 可覆盖）`,
      "",
    ].join("\n"),
  );
  return 0;
}

/**
 * 不给参数（或给了不认识的命令）：**进交互模式**（Phase 9）。
 *
 * ⚠️ 为什么"不认识的命令"也走这里而不是报错：终端里 `ding 你好` 这种写法很自然
 * （人不会先想"我要不要加 run"）。进交互模式并把这句当成任务，比报
 * "未知命令：你好"更贴近人的预期。而**真**打错的子命令（如 `ding sessionss`）
 * 会被当成任务发给模型 —— 它会说"我不确定你想干什么"，这也不比报错差。
 * 唯一要避免的是"静默什么都不做"，所以交互模式一定会有可见的回显。
 */
async function cmdDefault(p: Parsed, devMode: boolean): Promise<number> {
  // `help` / `--help` / `-h` 在任何时候都是帮助，不进交互
  if (p.command === "help" || p.flags.has("help") || p.flags.has("h")) return cmdHelp(devMode);

  const ready = replPrecondition();
  if (!ready.ok) {
    process.stderr.write(`${ready.reason}\n`);
    return 3;
  }

  const { config, note } = effectiveConfig(dataDir());
  if (note) process.stderr.write(`[配置] ${note}\n`);

  const dirs = workspaceDirs(flagAll(p, "dir").length ? flagAll(p, "dir") : (config.dirs ?? []));
  const built = await buildEngine(dirs);
  for (const problem of built.plugins) process.stderr.write(`[plugin] ${problem}\n`);

  const provider = flag(p, "provider") ?? config.provider ?? firstAvailableProvider()!.id;
  const mode = normalizeConfirmMode(flag(p, "mode") ?? config.mode ?? "全部允许");
  const sessionId = cliSessionId(`repl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);

  try {
    return await runRepl(
      {
        engine: built.engine,
        sessionId,
        provider,
        ...((flag(p, "model") ?? config.model) ? { model: flag(p, "model") ?? config.model } : {}),
        mode,
        dataDir: dataDir(),
        renderLatest: async () => {
          const snap = await built.engine.record(sessionId);
          if (snap) render(snap.records);
        },
      },
      config,
    );
  } finally {
    built.close();
  }
}

/* ────────────────────── 入口 ────────────────────── */

/**
 * 入口。
 *
 * ⚠️ 收进一个 `main()`，**不用顶层 await**：CLI 的发布产物是 **CommonJS**
 * （见 `tsconfig.cli.json` 的说明：源码里的相对 import 不写扩展名，ESM 不认），
 * 而 CJS 里顶层 await 是语法错误。tsx 直跑时两种都行 —— 所以这个坑只有
 * 在**真的构建一次产物**时才会露出来。
 */
async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));

  /* `--dev`：工程模式（Phase 9）。`record` / `replay` 是**验收驱动器**，不是产品表面 ——
   * 它们留在命令行里（脚本要用），但**不出现在默认帮助里**，除非显式 `--dev`。
   * 这样"给人看的命令面"与"给工程用的命令面"分得开，而两者还在同一个二进制里。 */
  const devMode = parsed.flags.has("dev");

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
              ? cmdModels(parsed)
              : parsed.command === "plugins"
                ? await cmdPlugins(parsed)
                : parsed.command === "eval"
                  ? await cmdEval(parsed)
                  : parsed.command === "config"
                  ? cmdConfig(parsed)
                  : parsed.command === "agents"
                    ? cmdAgents(parsed)
                    : await cmdDefault(parsed, devMode);
  process.exit(code);
}

void main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[31m出错了：${detail}[0m\n`);
  process.exit(1);
});
