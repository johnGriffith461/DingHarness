/**
 * CLI 的**真正入口**（L07，2026-10-18 从 `ding.ts` 拆出）。
 *
 * `ding.ts` 只留一层薄壳（`--version` / `--help` 不进这里）——
 * 于是那两条最常被脚本调用的命令**不付整个引擎与命令集的加载成本**。
 */

import fs from "node:fs/promises";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createEngine, type Engine, type EngineRunRequest } from "../../engine/index";
import { cliSessionId } from "../../engine/core/events";
import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { snapshotOf, type Snapshot } from "../../engine/core/snapshot";
import { allProviders, firstAvailableProvider, getProvider, isBuiltinProviderId, setCustomProviders } from "../../engine/runtime/providers";
import { PRODUCT_VERSION } from "../../shared/product";
import { budgetOf, parseBudgetMode, CONTEXT_BUDGET_MODES } from "../../engine/runtime/budget";
import { normalizeRules } from "../../engine/core/permissionRules";
import { capabilityOf, describeCapability, groupCatalog, recommendReason, type ModelCapability } from "../../engine/runtime/modelCatalog";
import { CONFIRM_MODES, normalizeConfirmMode, type ConfirmMode } from "../../shared/ipc";
import { runWithFallback, failoverNote } from "./providerFallback";
import { formatCount } from "../../shared/cost";
import { drainSteer } from "../../engine/runtime/inbox";
/* 只借两个纯路径助手（warnDesktopRoot 是同步判定，不能懒加载） */
import { desktopDataDir, resolveBackupDataDir } from "./cmdBackup";
import { buildEngine as buildEngineIn } from "./assembly";
import { renderRecords } from "./renderRecords";
import { KNOWN_COMMANDS, cmdCommandHelp, cmdHelp } from "./help";
import { ensureConfigured } from "./wizard";
import { configPaths, describeConfig, effectiveConfig, readConfig, writeConfig, type CliConfig } from "./config";
import { replPrecondition, runRepl } from "./repl";
import { flag, flagAll, KNOWN_FLAGS, parseArgv, parseIntFlagValue, type Parsed } from "./args";
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

/**
 * 数据目录：默认 `~/.ding`，可用 `DH_DATA_DIR` 覆盖（多份数据并行跑时用）。
 *
 * ⭐ **顺带认桌面的那个覆盖变量**（2026-10-16，审计 P129）。
 *
 * 桌面把数据放在 `app.getPath("userData")`（可用 `DSH_CANVAS_DATA_DIR` 覆盖，
 * 见 `electron/main.ts`），CLI 放在 `~/.ding` —— 两个根**互不相干**。
 * 后果：`ding backup` 备份的永远是 CLI 那一份，桌面那 14 个 store 与 `sessions.db`
 * **一行都没进备份**，而命令的输出让用户以为"备份好了"。
 *
 * 这里能做的（不越界改别人的 cmdBackup/backup.ts）：**同一台机器上给出同一个开关** ——
 * 你只要用同一个 `DSH_CANVAS_DATA_DIR` 启动桌面、再跑 CLI，两者就落在同一个根上，
 * 备份与恢复覆盖的才是同一批数据。`DH_DATA_DIR` 仍然优先（它更具体）。
 *
 * ⚠️ 另一半（备份/恢复时**显式说出**根在哪、以及桌面的那份在不在里面）要改
 * `hosts/cli/cmdBackup.ts` —— 那不在本工单的文件范围里。
 */
function dataDir(): string {
  return (
    process.env.DH_DATA_DIR?.trim() ||
    process.env.DSH_CANVAS_DATA_DIR?.trim() ||
    path.join(os.homedir(), ".ding")
  );
}

/**
 * 授权目录：默认当前目录，`--dir` 可重复给（与桌面的"工作区授权"是同一个概念）。
 */
function workspaceDirs(extra: readonly string[]): string[] {
  return (extra.length ? extra : [process.cwd()]).map((d) => path.resolve(d));
}

/* ────────────────────── 终端输出（走投影） ────────────────────── */

/*
 * 渲染**只有一份**（审计 P217 / NEW-N7-26）：`./renderRecords.ts` 的 `renderRecords`。
 * 这里原来另有一份 `render()`，与 `ding recipe run` 用的那份在 `view.error` /
 * `trace.pending` 两处都不一样 —— 两份口径必然漂，所以合成一份。
 */

/** 目录表里关于这个模型的那几行（`ding models --json` 用；未登记就如实说）。 */
function budgetInfo(modelId: string): Record<string, unknown> {
  const got = budgetOf(modelId);
  return {
    registered: got.registered,
    contextWindow: got.contextWindow,
    stale: got.stale,
  };
}

/**
 * 把 provider 表里的模型名**去重**成一条目录（D03）。
 *
 * 同一个模型会被好几家中转同时提供（`deepseek-chat` 出现在 4 家）。
 * 按 provider 逐行列出来就是审计说的"28 行重复 20k"；目录应该按**模型**说话，
 * provider 只作为「哪条路能到它」的参考。
 *
 * @param providerId 只取这一家的模型（不传 = 全部）
 */
function catalogRows(providerId?: string): ModelCapability[] {
  const providers = allProviders().filter((p) => !providerId || p.id === providerId);
  const seen = new Map<string, string>();
  for (const provider of providers) {
    for (const model of provider.models) {
      if (!seen.has(model)) seen.set(model, provider.id);
    }
  }
  return [...seen].map(([model, provider]) =>
    capabilityOf(model, {
      provider,
      // 自定义 provider 里的模型即使目录里碰巧同名，也应该标成 custom
      source: isBuiltinProviderId(provider) ? "builtin" : "custom",
    }),
  );
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

/**
 * 备份/恢复要用的根，并**在根与桌面不一致时当场说清**（审计 P129）。
 *
 * 不说的话，这条命令的输出会让人以为"已经备份好了"—— 而桌面那份数据
 * （`stores.db` / `sessions.db` / 画布快照）根本没进这个文件。
 * 给出可照做的下一步（用同一个 `DSH_CANVAS_DATA_DIR` 指过去）。
 *
 * ⚠️ 给了 `--data-dir` 时以它为准（那是用户**显式**指定的根，见 `resolveBackupDataDir`）——
 * 否则这里会比着 CLI 的根去提醒"桌面那份不在里面"，而用户其实已经指过去了。
 */
function warnDesktopRoot(p: Parsed): string {
  const root = resolveBackupDataDir(p, dataDir());
  const desktop = desktopDataDir();
  if (!p.flags.has("json") && desktop && path.resolve(desktop) !== path.resolve(root)) {
    process.stderr.write(
      `⚠️ 桌面应用的数据在：${desktop}\n` +
        `   这次只动 CLI 的根：${root} —— 桌面那份**不在里面**。\n` +
        `   要一起备份/恢复：用同一个目录跑两边，例如 ` +
        `DSH_CANVAS_DATA_DIR="${desktop}" ding ${p.command} …\n`,
    );
  }
  return root;
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
    process.stderr.write('用法：ding run "任务描述" [--dir <目录>] [--provider <id>] [--model <名>] [--mode <档位>] [--steps <整数>]\n');
    return 2;
  }

  /*
   * ⚠️ `--steps` **先验后用**（审计 P49）：坏值原来静默变 `NaN`，
   * 而 `stepCountIs(NaN)` 的判据恒假 —— "最多跑几步"这道防失控闸会**恒不成立**，
   * 表现却是"参数好像没生效"。
   */
  const steps = parseIntFlagValue(flag(p, "steps"), "steps", { min: 1, max: 1000, fallback: 8 });
  if (!steps.ok) {
    process.stderr.write(`${steps.message}\n`);
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

  const mode = normalizeConfirmMode(flag(p, "mode") ?? config.mode ?? "按需确认");
  /*
   * 后台任务（G06）：父进程生成会话 id 交给子进程（`DSH_SESSION_HINT`），
   * 这样 `ding jobs show` 能直接给出"用哪个会话看状态"。
   */
  const sessionId =
    process.env.DSH_SESSION_HINT?.trim() ||
    cliSessionId(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  /*
   * `--background`（G06）：**起一个脱离的子进程跑同一个命令**，父进程立刻返回。
   * 不在这里自己跑（那还是会占住终端，而且父进程一退就断）。
   */
  if (p.flags.has("background")) {
    const { spawnBackgroundRun } = await import("./cmdJobs");
    const plan = spawnBackgroundRun({ dataDir: dataDir(), argv: process.argv.slice(2), prompt: task, sessionId });
    process.stdout.write(`✓ 已交给后台：${plan.id}` + String.fromCharCode(10));
    process.stdout.write(`看进度：ding jobs show ${plan.id}` + String.fromCharCode(10));
    process.stdout.write(`会话：${sessionId}` + String.fromCharCode(10));
    return 0;
  }

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
    maxSteps: steps.value,
    /* 插话（G06）：每一步之前看一眼队列（没有就是空数组，零开销） */
    nextSteer: () => drainSteer(dataDir(), sessionId),
    ...(typeof config.maxBudgetUsd === "number" && config.maxBudgetUsd > 0
      ? { maxBudgetUsd: config.maxBudgetUsd }
      : {}),
  };

  /* 长回合进度打到 stderr（stdout 是结果，混在一起会污染重定向的产物） */
  /*
   * 故障转移（U15）：逻辑在 `./providerFallback.ts`（边界与口径写在那个文件头）。
   * 这里只负责把进度行接到 stderr —— 与原来那条逐字一致。
   */
  const fallbacks = (config.providerFallback ?? []).filter((id) => id !== provider && getProvider(id));
  const run = await runWithFallback({
    engine,
    request,
    primary: provider,
    fallbacks,
    modelFor: (id, index) => flag(p, "model") ?? (config.model && index === 0 ? config.model : undefined) ?? getProvider(id)!.models[0],
    onProgress: ({ step, totalTokens }) => {
      const head = step ? `第 ${step} 步` : "一步";
      const tail = totalTokens ? `（累计已用 ${formatCount(totalTokens)} token）` : "";
      process.stderr.write(`· ${head}${tail}
`);
    },
  });
  const outcome = run.outcome;
  {
    const note = failoverNote(run, provider);
    if (note) process.stderr.write(`[2m${note}[0m
`);
  }
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
          ...(outcome.state ? { state: outcome.state } : {}),
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
    process.stdout.write(renderRecords(outcome.records));
  }
  close();

  if (!outcome.ok && !outcome.aborted) {
    /*
     * 预算暂停（U01）不是"失败"：它是用户设的上限到了，加预算就能继续。
     * 所以文案与退出码都分开 —— 脚本能靠 `"state":"paused"` 或退出码 4 认出来。
     */
    if (outcome.state === "paused") {
      process.stderr.write(`\n\x1b[33m已暂停：${outcome.error ?? "达到预算上限"}\x1b[0m\n`);
      return 4;
    }
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
  const rows = catalogRows();

  if (p.flags.has("json")) {
    console.log(
      JSON.stringify(
        {
          /*
           * `providers` 保留原形状（兼容已有的脚本/文档）：那里仍然按 provider 列模型。
           * `catalog` 是 D03 的新面：按**模型**去重，带能力/价格/分组。
           */
          providers: allProviders().map((provider) => ({
            id: provider.id,
            label: provider.label,
            protocol: provider.protocol,
            baseURL: provider.baseURL,
            models: provider.models.map((m) => ({ id: m, ...budgetInfo(m) })),
          })),
          catalog: rows,
          groups: groupCatalog(rows).map(({ group, items }) => ({ group, models: items.map((i) => i.id) })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  process.stdout.write("按**模型**列（不是按 provider）；同一个模型可出现在多个分组里。\n");
  process.stdout.write("未登记模型只进「未登记」——我们不知道它的真实窗口，不拿估计值去花你的钱。\n");
  for (const { group, items } of groupCatalog(rows)) {
    process.stdout.write(`\n【${group}】\n`);
    for (const cap of items) {
      process.stdout.write(`  · ${describeCapability(cap)}\n`);
      if (group === "推荐") {
        const why = recommendReason(cap.id);
        if (why) process.stdout.write(`      为什么推荐：${why}\n`);
      }
    }
  }

  process.stdout.write("\n【provider 怎么到达它们】\n");
  for (const provider of allProviders()) {
    process.stdout.write(`${provider.id.padEnd(12)} ${provider.label}  [${provider.models.join(", ")}]\n`);
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
/**
 * 默认市场索引：从 cwd 往上找 `plugin-market/index.json`（V6-3d）。
 *
 * ⚠️ 仓库里那份只是**格式示例 + 本仓自带的插件**，不是线上市场。
 * 线上索引要一个稳定的 URL 与审核流程 —— 那是运营侧的事，不在这里假装已经有了。
 */
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
      console.error("用法：ding config set <provider|model|mode|dirs|contextBudget|rules|maxBudgetUsd> <值>（dirs 用逗号分隔）");
      return 2;
    }
    if (!["provider", "model", "mode", "dirs", "contextBudget", "rules", "maxBudgetUsd", "providerFallback"].includes(key)) {
      console.error(`不认识的键：${key}（可用：provider / model / mode / dirs / contextBudget / rules / maxBudgetUsd）`);
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
    } else if (key === "contextBudget") {
      const mode = parseBudgetMode(value);
      if (mode !== value) {
        console.error(`「${value}」不是有效预算档位。可用：${CONTEXT_BUDGET_MODES.join(" / ")}`);
        return 2;
      }
      next.contextBudget = mode;
    } else if (key === "rules") {
      /*
       * 规则一整份覆盖（不逐条追加）：规则表是**一份**有序清单，`findLast` 依赖顺序；
       * 逐条 append 会让"后写的覆盖先写的"变成"永远最后一条生效"，用户很难理解。
       */
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch (error) {
        console.error(`rules 必须是 JSON 数组：${error instanceof Error ? error.message : String(error)}`);
        return 2;
      }
      const rules = normalizeRules(parsed);
      if (!Array.isArray(parsed) || rules.length !== parsed.length) {
        console.error("rules 里有条目形状不对（要 {action, effect}，effect ∈ allow/deny/ask）");
        return 2;
      }
      next.rules = rules;
    } else if (key === "maxBudgetUsd") {
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount <= 0) {
        console.error(`「${value}」不是有效的金额（要正数，单位美元）`);
        return 2;
      }
      next.maxBudgetUsd = amount;
    } else if (key === "providerFallback") {
      /* 逗号分隔的 provider id 链；不去猜"哪个对"，只在 doctor 里报不认识的 */
      next.providerFallback = value.split(",").map((x: string) => x.trim()).filter(Boolean);
    } else if (key === "provider") next.provider = value;
    else next.model = value;

    const file = writeConfig(dir, next);
    const shown = key === "dirs" ? next.dirs?.join(" / ") : key === "rules" ? `${next.rules?.length ?? 0} 条` : value;
    console.log(`✓ ${key} = ${shown}`);
    console.log(`  写进了 ${file}`);
    return 0;
  }

  if (sub === "unset") {
    const key = p.args[1] as keyof CliConfig | undefined;
    if (!key || !["provider", "model", "mode", "dirs", "contextBudget", "rules", "maxBudgetUsd", "providerFallback"].includes(key)) {
      console.error("用法：ding config unset <provider|model|mode|dirs|contextBudget|rules|maxBudgetUsd>");
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

/**
 * 不给参数时：**进交互模式**（Phase 9）。
 *
 * ⚠️ 口径在 2026-10-16（审计 P212）**收窄过一次**，这段说明跟着改了：
 *   · 命令位置是一个 **ASCII 小写单词**（能对上 `[a-z][a-z-]*`）而**不是**已知命令
 *     → 在 `main()` 里当场报错退出 2：`ding restor …` 这种拼错不再静默进 REPL、
 *     也不再在脚本/CI 里把 stdin 吃干；
 *   · 其余的自由文本（中文、带空格的一整句）**照旧**当任务 —— 终端里 `ding 你好`
 *     这种写法很自然，进交互模式并把它当成任务，比报"未知命令"更贴近人的预期。
 * 唯一要避免的是"静默什么都不做"，所以交互模式一定会有可见的回显。
 */
async function cmdDefault(p: Parsed, devMode: boolean): Promise<number> {
  // `help` / `--help` / `-h` 在任何时候都是帮助，不进交互

  /*
   * 向导要临时借 stdin 问几句话；REPL 起来之后由它自己接管。
   * 所以这个 `rl` 在进 REPL 之前关掉（两个 readline 抢同一路输入会丢行）。
   */
  /*
   * 向导要临时借 stdin 问几句话；REPL 起来之后由它自己接管。
   * 所以这个 `rl` 在进 REPL 之前关掉（两个 readline 抢同一路输入会丢行）。
   *
   * ⚠️ 用**可变引用**（不是裸 const）：要是哪一问是"密钥"（`{secret:true}`），
   * `askMasked` 会把它关掉重建（遮蔽输入只能这么做），裸 const 之后就会
   * "关掉的是旧那个、真正在用的是新的" —— 两个 readline 抢输入，正是上面那句要避开的。
   */
  const rlRef = { current: createInterface({ input: process.stdin, output: process.stdout, terminal: false }) };
  /* 首次配置/REPL 才用得到（`askMasked` 随 cmdSetup 一起懒加载） */
  const { askMasked } = await import("./cmdSetup");
  const plainAsk = (q: string, opts?: { default?: string }) =>
    new Promise<string>((resolve) => {
      const suffix = opts?.default ? ` [${opts.default}]` : "";
      rlRef.current.question(`${q}${suffix} `, (answer) => resolve(answer.trim() || opts?.default || ""));
    });
  if (p.command === "help" || p.flags.has("help") || p.flags.has("h")) return cmdHelp(devMode, dataDir());

  /*
   * ⚠️ 先过**首次配置**这道门（Phase 11.3）。
   *
   * 原来是直接 `replPrecondition()` 报错退出 —— 一个刚装好的人看到的是
   * 「没有可用的 provider」然后进程结束（方案 U1 要的是「五分钟上手」）。
   * 现在没配就走向导：配 key → 选模型 → 选目录，两分钟。
   *
   * 非交互环境（管道 / CI）里向导**不提问**：`ensureConfigured(null, …)` 只给一句
   * 能照做的说明 —— 在 CI 里等输入的向导会把流水线卡死。
   */
  const configured = await ensureConfigured(
    process.stdin.isTTY
      ? {
          /*
           * ⚠️ 这一份 `ask` 原来**也**忽略 `opts.secret`（审计 P199 点名的第二处：
           * 首次 `ding` 走的就是这条路）。现在与 `ding init` 共用同一个遮蔽实现 ——
           * 两处各写一遍正是这条缺陷能同时存在两次的原因。
           */
          ask: (q, opts) =>
            opts?.secret ? askMasked(rlRef, `${q} `, () => plainAsk(q, opts)) : plainAsk(q, opts),
          say: (line) => process.stdout.write(line + "\n"),
        }
      : null,
    { dataDir: dataDir() },
  );
  if (!configured.ok) {
    process.stderr.write(`${configured.reason ?? "还没配好"}\n`);
    return 3;
  }
  rlRef.current.close();

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
  const mode = normalizeConfirmMode(flag(p, "mode") ?? config.mode ?? "按需确认");
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
          if (snap) process.stdout.write(renderRecords(snap.records));
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
export async function runMain(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));

  /*
   * ⭐ **参数层面的错在这里拦，不在命令里各自静默**（审计 P50 / P219 / P220）：
   * 缺值的值旗标、空值、不认识的旗标 —— 从前它们全都无声通过，
   * 表现成"我明明给了 --provider"或"参数好像没生效"。
   */
  if (parsed.problems?.length) {
    process.stderr.write(`${parsed.problems.map((line) => `参数不对：${line}`).join("\n")}\n`);
    process.exit(2);
  }
  if (parsed.flags.has("version")) {
    /*
     * 优先读**安装包自己的** package.json：CLI 可以有补丁版（例如 0.5.1 只修依赖），
     * 而 `PRODUCT_VERSION` 跟着产品走。两者不一致时，用户问"我装的是哪一版"，
     * 答案应该是装的那一个。
     */
    const candidates: string[] = [];
    /* 先看**安装包自己**的（dist-cli/hosts/cli → 包根）；源码跑时 __dirname 不存在，再落到 cwd */
    if (typeof __dirname === "string") {
      candidates.push(path.join(__dirname, "..", "..", "..", "package.json"), path.join(__dirname, "..", "..", "package.json"));
    }
    candidates.push(path.join(process.cwd(), "package.json"));
    let version = PRODUCT_VERSION;
    for (const file of candidates) {
      try {
        const parsedPkg = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown; version?: unknown };
        if (parsedPkg.name === "ding-harness" && typeof parsedPkg.version === "string") {
          version = parsedPkg.version;
          break;
        }
      } catch {
        /* 试下一个 */
      }
    }
    process.stdout.write(`${version}\n`);
    process.exit(0);
  }
  /*
   * **子命令的 --help**（U11）：`ding run --help` 应该是"告诉我怎么用"，
   * 而不是"缺参数，退出码 2"。顶层 `--help` 仍走 `cmdDefault` 那一处。
   */
  if (parsed.command && (parsed.flags.has("help") || parsed.flags.has("h"))) {
    process.exit(cmdCommandHelp(parsed.command, parsed.flags.has("dev")));
  }
  if (parsed.unknown?.length) {
    process.stderr.write(
      `不认识的旗标：${parsed.unknown.map((key) => `--${key}`).join(" / ")}（拼错了？要传字面量就用 -- 隔开）\n` +
        `可用旗标：${[...KNOWN_FLAGS].join(" / ")}\n`,
    );
    process.exit(2);
  }

  /*
   * 自定义 provider（V6-2j）：启动时把配置里那批交给内核。
   * 被拒的条目**明确提示**（同名内置/字段不合法）—— 静默丢弃会让用户以为"配了没生效"。
   */
  {
    const custom = readConfig(dataDir()).config.providers ?? [];
    if (custom.length || process.env.DH_STRICT_PROVIDERS) {
      const { rejected } = setCustomProviders(custom);
      for (const item of rejected) process.stderr.write(`⚠️ 自定义 provider「${item.id}」没生效：${item.why}\n`);
    }
  }

  /* `--dev`：工程模式（Phase 9）。`record` / `replay` 是**验收驱动器**，不是产品表面 ——
   * 它们留在命令行里（脚本要用），但**不出现在默认帮助里**，除非显式 `--dev`。
   * 这样"给人看的命令面"与"给工程用的命令面"分得开，而两者还在同一个二进制里。 */
  const devMode = parsed.flags.has("dev");

  /*
   * ⭐ **不认识的子命令要报错，不能静默进 REPL**（2026-10-16，审计 P212）。
   *
   * 缺陷形状：这条三元链落到底就是 `cmdDefault`（进交互模式），只有 `help` 被特判。
   * 于是 `ding restore backup.json` 打成 `ding restor backup.json` 时：
   * 交互终端里"进了 REPL"（用户以为自己命令写对了），脚本/CI 里进程**吃掉 stdin 等输入** ——
   * 一个拼写错误被静默执行成了完全不同的事。
   *
   * 口径（不用新旗标、不改 args.ts）：命令位置是一个**ASCII 小写单词**（`[a-z][a-z-]*`）
   * 且不在已知命令表里 → 报错退出 2，并告诉他想跑一句话该用 `ding run "…"`。
   * 中文/带空格的自由文本**照旧**当任务（`ding 你好` 这条自然写法不受影响）。
   */
  const knownCommands = KNOWN_COMMANDS;
  if (parsed.command && !knownCommands.has(parsed.command) && /^[a-z][a-z-]*$/.test(parsed.command)) {
    process.stderr.write(
      `不认识的命令：${parsed.command}（可用：${[...knownCommands].join(" / ")}）\n` +
        `要跑一句话当任务，用：ding run "${parsed.args.join(" ") || "…"}"\n`,
    );
    process.exit(2);
  }

  /*
   * 命令分派改成**查表**（L 系列收口）：原来那条三元链每加一条命令就深一层，
   * 到二十几条时已经无法阅读（缩进也早就对不上）。表里没有的命令走 `cmdDefault`
   * （帮助 / REPL）；"拼错要报错"那道守卫在上面，与这里无关。
   */
  const handlers: Record<string, () => number | Promise<number>> = {
    run: () => cmdRun(parsed),
    sessions: async () => (await import("./cmdSessions")).cmdSessions(parsed, dataDir()),
    review: async () => (await import("./cmdReview")).cmdReview(parsed, dataDir()),
    stats: async () => (await import("./cmdStats")).cmdStats(parsed, dataDir()),
    board: async () => (await import("./cmdBoard")).cmdBoard(parsed, dataDir()),
    export: async () => (await import("./cmdTransfer")).cmdExport(parsed, dataDir(), PRODUCT_VERSION),
    import: async () => (await import("./cmdTransfer")).cmdImport(parsed, dataDir()),
    tree: async () => (await import("./cmdTree")).runTreeCommand(parsed, dataDir()),
    jobs: async () => (await import("./cmdJobs")).cmdJobs(parsed, dataDir()),
    steer: async () => (await import("./cmdJobs")).cmdSteer(parsed, dataDir()),
    record: () => cmdRecord(parsed),
    replay: () => cmdReplay(parsed),
    models: () => cmdModels(parsed),
    plugins: async () => (await import("./cmdPlugins")).cmdPlugins(parsed, dataDir()),
    recipe: async () => (await import("./cmdRecipe")).cmdRecipe(parsed, dataDir()),
    approvals: async () => (await import("./cmdApprovals")).cmdApprovals(parsed),
    sync: async () => (await import("./cmdSync")).cmdSync(parsed, dataDir()),
    space: async () => (await import("./cmdSpace")).cmdSpace(parsed, dataDir()),
    serve: async () => (await import("./cmdServe")).cmdServe(parsed, dataDir()),
    connect: async () => (await import("./cmdConnect")).cmdConnect(parsed),
    acp: async () => (await import("./cmdServe")).cmdAcp(parsed, dataDir()),
    resume: async () => (await import("./cmdResume")).cmdResume(parsed, dataDir()),
    backup: async () => (await import("./cmdBackup")).cmdBackup(parsed, warnDesktopRoot(parsed)),
    restore: async () => (await import("./cmdBackup")).cmdRestore(parsed, warnDesktopRoot(parsed)),
    doctor: async () => (await import("./cmdSetup")).cmdDoctor(parsed, dataDir()),
    init: async () => (await import("./cmdSetup")).cmdInit(parsed, dataDir()),
    eval: async () => (await import("./cmdEval")).cmdEval(parsed),
    bench: async () => (await import("./cmdBench")).cmdBench(parsed),
    fork: async () => (await import("./cmdFork")).cmdFork(parsed, dataDir()),
    worktree: async () => (await import("./cmdWorktree")).cmdWorktree(parsed),
    knowledge: async () => (await import("./cmdKnowledge")).cmdKnowledge(parsed, dataDir()),
    "acp-drive": async () => (await import("./cmdAcpDrive")).cmdAcpDrive(parsed),
    providers: async () => (await import("./cmdProviders")).cmdProviders(parsed, dataDir()),
    schedule: async () => (await import("./cmdSchedule")).cmdSchedule(parsed, dataDir()),
    im: async () => (await import("./cmdIm")).cmdIm(parsed, dataDir()),
    memory: async () => (await import("./cmdMemory")).cmdMemory(parsed, dataDir()),
    workflow: async () => (await import("./cmdWorkflow")).cmdWorkflow(parsed, dataDir()),
    config: () => cmdConfig(parsed),
    agents: () => cmdAgents(parsed),
  };
  const handler = parsed.command ? handlers[parsed.command] : undefined;
  const code = handler ? await handler() : await cmdDefault(parsed, devMode);
  /* 后台任务的子进程：把结束状态写回 jobs.jsonl（父进程那边只是兜底） */
  if (process.env.DSH_JOB_ID) {
    const { recordJobExit } = await import("./cmdJobs");
    recordJobExit(dataDir(), code);
  }
  process.exit(code);
}
