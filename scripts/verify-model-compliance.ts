/**
 * F-06（2026-10-20）：**多模型协议工具合规性**实测（真 provider，花钱）。
 *
 * 用法：
 *
 *   pnpm cli:build
 *   npx tsx scripts/verify-model-compliance.ts --yes-spend
 *
 * 没有 `--yes-spend` 一律拒跑；`DING_NO_REAL_MODEL` / `DSH_NO_REAL_MODEL` 任一开着也拒跑。
 *
 * ## 它测什么
 *
 * 两家 provider（不同厂商）× 三件任务：
 * 1. **修失败测试**：要 `run_command` + `finish`（完成契约）；
 * 2. **三步任务**：要 `todo_write`（计划协议）；
 * 3. **信息不足**：要 `ask_user`（澄清协议）。
 *
 * 每件任务记录：工具有没有调、参数是否通过**同一份 zod schema**、失败在哪一步、
 * 有没有重试（同签名重复调用）、真实 token 与墙钟。
 *
 * ## 证据
 *
 * `.verify/model-compliance/results-<时间>.json`（原始）+ 终端里的 markdown 表。
 * 结果只来自这次真实运行 —— 不引用别处数字，不补全空字段。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createSqliteSessionStore } from "../engine/adapters/sqliteStore";
import { ASK_USER_INPUT, FINISH_INPUT, TODO_WRITE_INPUT } from "../shared/agentTools";

type TaskId = "fix-test" | "three-step" | "ask-when-ambiguous";

type ProviderTarget = { id: string; model: string };

/*
 * 2026-10-20 实测后的选择（见 BENCHMARKS §10）：
 * - `deepseek/deepseek-chat`：官方直连，可用；
 * - `tokenrhythm/deepseek-flash`：中转，可用；
 * - `qianwen/qwen-plus`：本机 key 存在但上游回「余额不足」，三件任务全部 0 token 失败；
 * - `apihub/deepseek-chat`：本机 DNS 解析不到 `api.apihub.top`（`ENOTFOUND`）。
 * 后两家不是协议不合规，是**通道本身不可用** —— 如实记，不拿它们充数。
 */
const PROVIDERS: ProviderTarget[] = [
  { id: "deepseek", model: "deepseek-chat" },
  { id: "tokenrhythm", model: "deepseek-flash" },
];

const TASKS: Array<{ id: TaskId; title: string; prompt: string; setup: (dir: string) => void }> = [
  {
    id: "fix-test",
    title: "修失败测试（要 run_command + finish）",
    prompt:
      "这个目录里有一个失败的检查脚本 check.mjs（运行 `node check.mjs` 会以退出码 1 结束）。" +
      "请先读它、修好它，再运行 `node check.mjs` 确认退出码是 0，最后调用 finish（status=done），" +
      "并在 evidence.commands 里原样写你实际跑过的命令。",
    setup: (dir) => {
      fs.writeFileSync(
        path.join(dir, "check.mjs"),
        [
          'const ok = false;',
          'if (!ok) {',
          '  console.error("check failed: ok is false");',
          "  process.exit(1);",
          "}",
          'console.log("ok");',
          "",
        ].join("\n"),
        "utf8",
      );
    },
  },
  {
    id: "three-step",
    title: "三步任务（要 todo_write）",
    prompt:
      "请分三步完成，开始前**先用 todo_write** 把这三步写进待办：" +
      "1) 读 README.md；2) 数它有多少行；3) 用一句话总结内容。" +
      "三步都做完后调用 finish（status=done）。",
    setup: (dir) => {
      fs.writeFileSync(
        path.join(dir, "README.md"),
        ["# 示例项目", "", "这是一个用于验证三步任务的小文件。", "", "它一共五行。", ""].join("\n"),
        "utf8",
      );
    },
  },
  {
    id: "ask-when-ambiguous",
    title: "信息不足（要 ask_user）",
    prompt: "帮我改一下那个配置文件。",
    setup: () => {
      /* 空目录：没有任何"那个配置文件"的线索 */
    },
  },
];

type RunResult = {
  provider: string;
  model: string;
  task: TaskId;
  exitCode: number | null;
  wallMs: number;
  timedOut: boolean;
  sessionId?: string;
  tokens: { input: number; output: number };
  tools: string[];
  finish: { called: boolean; paramsOk: boolean; status?: string; evidenceCommands: number };
  runCommand: { called: boolean; ok: boolean };
  todoWrite: { called: boolean; paramsOk: boolean; items: number };
  askUser: { called: boolean; paramsOk: boolean };
  toolErrors: number;
  repeatedCalls: number;
  textHead: string;
  stderrHead: string;
};

const args = process.argv.slice(2);
if (!args.includes("--yes-spend")) {
  console.error("这条会真调 provider（花钱）。确认要跑就加 --yes-spend。");
  process.exit(2);
}
if (process.env.DING_NO_REAL_MODEL?.trim() || process.env.DSH_NO_REAL_MODEL?.trim()) {
  console.error("DING_NO_REAL_MODEL / DSH_NO_REAL_MODEL 开着 —— 这是「禁止真实模型」的闸，本脚本拒跑。");
  process.exit(2);
}

const ROOT = path.resolve(".verify", "model-compliance");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = path.join(ROOT, `results-${STAMP}.json`);
const CLI = path.join("dist-cli", "hosts", "cli", "ding.js");

if (!fs.existsSync(CLI)) {
  console.error(`CLI 产物不存在（${CLI}）—— 先 pnpm cli:build。`);
  process.exit(2);
}
fs.mkdirSync(ROOT, { recursive: true });

function envFor(dataDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DING_NO_REAL_MODEL;
  delete env.DSH_NO_REAL_MODEL;
  delete env.ELECTRON_RUN_AS_NODE;
  env.DING_DATA_DIR = dataDir;
  return env;
}

async function inspectSession(dataDir: string, sessionId: string): Promise<{
  tools: string[];
  toolErrors: number;
  repeatedCalls: number;
  tokens: { input: number; output: number };
  toolCalls: Array<{ name: string; input: unknown }>;
}> {
  const store = createSqliteSessionStore(dataDir);
  try {
    const { records } = await store.load(sessionId);
    const tools: string[] = [];
    const toolCalls: Array<{ name: string; input: unknown }> = [];
    const signatures = new Map<string, number>();
    let toolErrors = 0;
    let repeatedCalls = 0;
    let input = 0;
    let output = 0;
    for (const record of records) {
      const r = record as Record<string, unknown>;
      if (r.type === "tool-call") {
        const name = typeof r.toolName === "string" ? r.toolName : "";
        tools.push(name);
        toolCalls.push({ name, input: r.input });
        const sig = `${name}:${JSON.stringify(r.input ?? null)}`;
        const count = (signatures.get(sig) ?? 0) + 1;
        signatures.set(sig, count);
        if (count > 1) repeatedCalls += 1;
      }
      if (r.type === "tool-result" && typeof r.error === "string" && r.error.trim()) toolErrors += 1;
      if (r.type === "done") {
        const usage = r.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
        if (typeof usage?.inputTokens === "number") input += usage.inputTokens;
        if (typeof usage?.outputTokens === "number") output += usage.outputTokens;
      }
    }
    return { tools, toolErrors, repeatedCalls, tokens: { input, output }, toolCalls };
  } finally {
    store.close();
  }
}

function parseLastJson(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  if (!text) return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function runOne(provider: ProviderTarget, task: (typeof TASKS)[number]): Promise<RunResult> {
  const base = path.join(ROOT, `${provider.id}-${task.id}`);
  const dataDir = path.join(base, "data");
  const workspace = path.join(base, "workspace");
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  task.setup(workspace);
  /* 单任务预算闸：到上限就暂停（不是"失败"）。$0.5 对这三件小事足够宽。 */
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ maxBudgetUsd: 0.5 }, null, 2), "utf8");

  const started = Date.now();
  const got = spawnSync(
    process.execPath,
    [
      CLI,
      "run",
      task.prompt,
      "--dir",
      workspace,
      "--provider",
      provider.id,
      "--model",
      provider.model,
      "--mode",
      "allow",
      "--steps",
      "12",
      "--json",
    ],
    { env: envFor(dataDir), encoding: "utf8", timeout: 240_000 },
  );
  const wallMs = Date.now() - started;
  const stdout = got.stdout ?? "";
  const stderr = got.stderr ?? "";
  const parsed = parseLastJson(stdout) ?? {};
  const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
  const inspected = sessionId
    ? await inspectSession(dataDir, sessionId)
    : { tools: [], toolErrors: 0, repeatedCalls: 0, tokens: { input: 0, output: 0 }, toolCalls: [] };

  const finishCalls = inspected.toolCalls.filter((c) => c.name === "finish");
  const todoCalls = inspected.toolCalls.filter((c) => c.name === "todo_write");
  const askCalls = inspected.toolCalls.filter((c) => c.name === "ask_user");
  const runCalls = inspected.toolCalls.filter((c) => c.name === "run_command");

  const finishCheck = finishCalls.map((c) => FINISH_INPUT.safeParse(c.input));
  const todoCheck = todoCalls.map((c) => TODO_WRITE_INPUT.safeParse(c.input));
  const askCheck = askCalls.map((c) => ASK_USER_INPUT.safeParse(c.input));
  const finishEvidence =
    finishCalls.length && finishCalls[finishCalls.length - 1].input && typeof finishCalls[finishCalls.length - 1].input === "object"
      ? ((finishCalls[finishCalls.length - 1].input as { evidence?: { commands?: unknown } }).evidence?.commands as unknown)
      : undefined;

  return {
    provider: provider.id,
    model: provider.model,
    task: task.id,
    exitCode: got.status,
    wallMs,
    /* spawnSync 超时被杀时 `signal` 是 SIGTERM；不依赖 `error.code`（类型上是 Error） */
    timedOut: got.signal === "SIGTERM" || wallMs >= 239_000,
    ...(sessionId ? { sessionId } : {}),
    tokens: inspected.tokens,
    tools: [...new Set(inspected.tools)],
    finish: {
      called: finishCalls.length > 0,
      paramsOk: finishCheck.length > 0 && finishCheck.every((r) => r.success),
      ...(finishCheck.length && finishCheck[finishCheck.length - 1].success
        ? { status: (finishCheck[finishCheck.length - 1].data as { status: string }).status }
        : {}),
      evidenceCommands: Array.isArray(finishEvidence) ? finishEvidence.length : 0,
    },
    runCommand: { called: runCalls.length > 0, ok: runCalls.length > 0 && runCalls.some((c) => c && inspected.toolErrors === 0) },
    todoWrite: {
      called: todoCalls.length > 0,
      paramsOk: todoCheck.length > 0 && todoCheck.every((r) => r.success),
      items:
        todoCheck.length && todoCheck[todoCheck.length - 1].success
          ? (todoCheck[todoCheck.length - 1].data as { todos: unknown[] }).todos.length
          : 0,
    },
    askUser: { called: askCalls.length > 0, paramsOk: askCheck.length > 0 && askCheck.every((r) => r.success) },
    toolErrors: inspected.toolErrors,
    repeatedCalls: inspected.repeatedCalls,
    textHead:
      typeof parsed.text === "string" ? parsed.text.replace(/\s+/g, " ").slice(0, 200) : "",
    stderrHead: stderr.replace(/\s+/g, " ").slice(0, 200),
  };
}

const results: RunResult[] = [];
for (const provider of PROVIDERS) {
  for (const task of TASKS) {
    process.stderr.write(`\n[${provider.id}/${provider.model}] ${task.title} …\n`);
    const result = await runOne(provider, task);
    results.push(result);
    process.stderr.write(
      `  exit=${result.exitCode} ${result.wallMs}ms tokens=${result.tokens.input}+${result.tokens.output} ` +
        `tools=${result.tools.join(",") || "（无）"}\n`,
    );
  }
}

fs.writeFileSync(OUT, JSON.stringify({ stamp: STAMP, providers: PROVIDERS, results }, null, 2), "utf8");

/* markdown 表：只写这次真的跑出来的数 */
const lines: string[] = [];
lines.push(`# 多模型协议工具合规性（${STAMP}）`);
lines.push("");
lines.push("| provider/model | 任务 | 退出码 | 墙钟 | tokens(in+out) | 工具 | todo 合规 | ask 合规 | finish/证据 | 工具失败 | 重复调用 |");
lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of results) {
  lines.push(
    `| ${r.provider}/${r.model} | ${r.task} | ${r.exitCode ?? "?"} | ${(r.wallMs / 1000).toFixed(1)}s | ${r.tokens.input}+${r.tokens.output} | ${
      r.tools.join(",") || "（无）"
    } | ${r.todoWrite.called ? (r.todoWrite.paramsOk ? `是（${r.todoWrite.items} 项）` : "参数不合规") : "未调用"} | ${
      r.askUser.called ? (r.askUser.paramsOk ? "是" : "参数不合规") : "未调用"
    } | ${r.finish.called ? `${r.finish.status ?? "?"}/${r.finish.evidenceCommands} 条证据` : "未调用"} | ${r.toolErrors} | ${r.repeatedCalls} |`,
  );
}
const table = lines.join("\n");
fs.writeFileSync(path.join(ROOT, `results-${STAMP}.md`), `${table}\n`, "utf8");
console.log(`\n${table}\n`);
console.log(`原始证据：${OUT}`);
