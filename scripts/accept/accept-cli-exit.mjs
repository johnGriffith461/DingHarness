import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

import { freshDir } from "./harness.mjs";

/**
 * CLI 退出路径（A-02）。
 *
 * ## 挡的是哪一种坏
 *
 * 掌舵实测：`ding run --mode allow` 打印完结果后出现
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
 *   EXIT=127
 *
 * 退出码 127 在脚本里会被当成"命令不存在"这类环境错误，而真正的问题是
 * **退出时还有句柄在关闭途中就被 `process.exit()` 硬切了**。
 * 这条脚本把三条出口（成功 / 失败 / 待确认）各跑一次，并要求：
 *
 * - 成功 = 0；失败 = 1；待确认在 A-03 之后 = 6（此前允许 0 或 6）；
 * - stderr 不含 `Assertion failed`；
 * - stdout 不含 `UV_HANDLE_CLOSING`。
 *
 * 用本地假通道（零出网）：这条验的是**进程退出**，不是模型行为。
 */

const DATA = ".verify/cli-exit-data";
await freshDir(DATA);
const WORK = path.join(DATA, "work");
fs.mkdirSync(WORK, { recursive: true });
const KEYS = path.join(DATA, "keys.yaml");
fs.writeFileSync(KEYS, "refs:\n  STRATA_API_KEY: cli-exit-fake\n", "utf8");

const CLI = path.join("dist-cli", "hosts", "cli", "ding.js");
if (!fs.existsSync(CLI)) {
  console.error(`✗ 没有编译产物 ${CLI} —— 先跑 pnpm cli:build`);
  process.exit(1);
}

/** 假通道当前的行为（由每次运行前设置）。 */
let behaviour = "write";
let requests = 0;

const CHUNK = { id: "cli-exit", object: "chat.completion.chunk", created: 0, model: "deepseek-flash" };
const textChunk = (t) => ({ ...CHUNK, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
const stopChunk = () => ({ ...CHUNK, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
const toolChunk = (id, name, args) => ({
  ...CHUNK,
  choices: [
    {
      index: 0,
      delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] },
      finish_reason: null,
    },
  ],
});

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "deepseek-flash" }] }));
      return;
    }
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      /* 当空 */
    }
    if (behaviour === "fail") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "验收假通道：故意失败" } }));
      return;
    }
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const hasToolRound = messages.some(
      (m) => m?.role === "tool" || (Array.isArray(m?.tool_calls) && m.tool_calls.length),
    );
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    requests += 1;
    if (!hasToolRound) {
      write(toolChunk(`call-${requests}`, "write_file", JSON.stringify({ path: "notes.md", content: "hello\n" })));
      write({ ...CHUNK, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      write(textChunk("写好了。"));
      write(stopChunk());
    }
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

/** 跑一次 CLI，收齐输出与退出码。 */
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        DING_DATA_DIR: path.join(DATA, "ding"),
        DSH_CREDENTIALS_FILE: KEYS,
        DING_NO_REAL_MODEL: "1",
        STRATA_BASE_URL: `http://127.0.0.1:${port}/v1`,
        STRATA_API_KEY: "cli-exit-fake",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const baseArgs = [
  "run",
  "把 notes.md 写出来",
  "--dir",
  WORK,
  "--provider",
  "strata",
  "--model",
  "deepseek-flash",
  "--steps",
  "4",
];

const cases = [
  { name: "成功（全部允许）", behaviour: "write", extra: ["--mode", "全部允许"], expect: [0] },
  { name: "失败（provider 500）", behaviour: "fail", extra: ["--mode", "全部允许"], expect: [1] },
  /* A-03 之后待确认 = 6（脚本能把它与"做完了"区分开） */
  { name: "待确认（按需确认）", behaviour: "write", extra: [], expect: [6] },
];

const failures = [];
for (const item of cases) {
  behaviour = item.behaviour;
  const got = await runCli([...baseArgs, ...item.extra]);
  const bad =
    !item.expect.includes(got.code) ||
    got.stderr.includes("Assertion failed") ||
    got.stdout.includes("UV_HANDLE_CLOSING") ||
    got.stderr.includes("UV_HANDLE_CLOSING");
  if (bad) {
    failures.push(
      `${item.name}：退出码 ${got.code}（期望 ${item.expect.join(" 或 ")}）\n` +
        `  stderr 尾部：${got.stderr.trim().split("\n").slice(-3).join(" | ") || "（空）"}\n` +
        `  stdout 尾部：${got.stdout.trim().split("\n").slice(-3).join(" | ") || "（空）"}`,
    );
  } else {
    console.log(`✓ ${item.name}：退出码 ${got.code}，无断言文本`);
  }
  /* 每条之间留一点时间，让 SQLite/子进程的句柄彻底收掉，避免下一条读到上一条的残留 */
  await new Promise((resolve) => setTimeout(resolve, 300));
}

/*
 * 连跑 5 次成功路径：偶发崩溃必须在这里露出来（一次干净不算数）。
 * 这是方案里"本机连跑 5 次无断言"的那一条。
 */
behaviour = "write";
for (let i = 0; i < 5; i += 1) {
  const got = await runCli([...baseArgs, "--mode", "全部允许"]);
  if (
    got.code !== 0 ||
    got.stderr.includes("Assertion failed") ||
    got.stdout.includes("UV_HANDLE_CLOSING") ||
    got.stderr.includes("UV_HANDLE_CLOSING")
  ) {
    failures.push(`连跑第 ${i + 1} 次：退出码 ${got.code}；stderr 尾部 ${got.stderr.trim().split("\n").slice(-2).join(" | ")}`);
  }
}
if (!failures.length) console.log("✓ 连跑 5 次成功路径：退出码全 0，无断言文本");

server.close();

if (failures.length) {
  console.error("\n✗ CLI 退出路径有失败：");
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log("\n✓ CLI 退出路径干净（成功 0 / 失败 1 / 待确认不崩 / 连跑 5 次无断言）");
