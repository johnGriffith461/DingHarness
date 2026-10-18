import { chromium } from "playwright";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, pickPort, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**子智能体被闸门拦下的动作会冒泡成父级待批，并且真的能批**（G11）。
 *
 * ## 之前缺的是什么
 *
 * `blockedToTraces()` 写好了却没人调用：子智能体撞上「按需确认」时，
 * 报告里有一句"想做但没被批准"，而界面上**没有任何按钮能批它**。
 *
 * ## 这条怎么在不花钱的前提下验完整条路
 *
 * 起一个**本地假 OpenAI 通道**（与本仓批跑里那台同形），按提示词里的标记分两步：
 *   ① 父级那一轮：回一个 `spawn_agent` 调用（任务里带着子任务原文）；
 *   ② 子智能体那一轮：看到任务里的"请调用 memory_save 工具" → 回一个 `memory_save` 调用。
 * 「按需确认」档下它会被拦成 pending，于是子智能体报告里出现 `blocked`。
 *
 * 判据（三层，缺一不可）：
 *   · 界面：父级这一步下面出现 `memory_save` 的**待批行**（G11 修的就是这个）；
 *   · 磁盘：批准**之前** `memory.json` 里没有那条（没有偷偷执行）；
 *   · 磁盘：点「允许」之后那条**真的写进去**（批准是在父级真执行一次，不是只改字）。
 */
const DATA = ".verify/subagent-approval-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const KEY = "G11-子智能体冒泡";

/* ── 本地假通道（零出网） ── */
let seq = 0;
const fake = createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "accept-fake" }] }));
      return;
    }
    let msgs = [];
    try {
      msgs = JSON.parse(raw)?.messages ?? [];
    } catch {
      /* 当空 */
    }
    const textOf = (m) => {
      const c = m?.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
      return "";
    };
    const lastUser = [...msgs].reverse().find((m) => m?.role === "user");
    const userText = lastUser ? textOf(lastUser) : "";
    const hasTool = msgs.some((m) => m?.role === "tool" || (Array.isArray(m?.tool_calls) && m.tool_calls.length));

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const line = (delta, finish) =>
      `data: ${JSON.stringify({ id: "acc", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
    const toolCall = (name, args) => {
      seq += 1;
      const id = `acc-call-${seq}`;
      res.write(line({ role: "assistant" }, null));
      res.write(
        line(
          {
            tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }],
          },
          null,
        ),
      );
      res.write(line({}, "tool_calls"));
      res.end("data: [DONE]\n\n");
    };

    if (!hasTool && /请调用\s*spawn_agent\s*工具/.test(userText)) {
      /* 把整句人话当子任务交下去（真模型也是给一个自包含的 task） */
      const task = /任务：(.+)$/.exec(userText)?.[1] ?? userText;
      toolCall("spawn_agent", JSON.stringify({ task: task.slice(0, 600) }));
      return;
    }
    if (!hasTool && /请调用\s*memory_save\s*工具/.test(userText)) {
      toolCall("memory_save", JSON.stringify({ text: KEY }));
      return;
    }
    res.write(line({ role: "assistant", content: "子智能体那一步被闸门拦下了，等你批准。" }, null));
    res.write(line({}, "stop"));
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((resolve) => fake.listen(0, "127.0.0.1", () => resolve()));
const fakePort = fake.address().port;

const out = {};
const keysFile = path.join(DATA, "keys.yaml");
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(keysFile, "refs:\n  STRATA_API_KEY: accept-local-fake\n", "utf8");
/*
 * ⚠️ 必须走 `bootApp` 的 `extraEnv`（它自己从 `process.env` 组装并删 `ELECTRON_RUN_AS_NODE`）。
 * 第一版我在这里改了一个本地 `env` 对象、却没传给 bootApp —— 应用于是拿到**真实**的
 * `DEEPSEEK_API_KEY` 并真调了一次远程模型（花了一次钱，且子智能体那条路被真实 provider
 * 的分组选走）。教训：起应用的环境**只能从那一个入口**给。
 */
const extraEnv = {
  DSH_CREDENTIALS_FILE: keysFile,
  DSH_NO_REAL_MODEL: "1",
  /* 与批跑同一个口径：配置型数据走文件后端，断言可以直接读 memory.json */
  DSH_STORE_BACKEND: "file",
  STRATA_BASE_URL: `http://127.0.0.1:${fakePort}`,
  STRATA_API_KEY: "accept-local-fake",
};

const booted = await bootApp({ port: await pickPort([9371]), dataDir: DATA, timeoutMs: 30000, extraEnv });
const { child, ok, getLog } = booted;
try {
  if (!ok) throw new Error("应用没起来：" + (getLog() || "").slice(-600));
  const b = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  /*
   * 档位：按需确认（写动作要停下来）+ **单独放行 spawn_agent**。
   *
   * 为什么必须放行父级那一下：`spawn_agent` 在策略表里也是写，按需确认下它自己
   * 先被拦住 —— 子智能体根本没跑，也就没有 blocked 可冒泡。规则层（U03）正好
   * 允许逐项放行：只把派活放过去，子智能体里的 `memory_save` 仍然要问。
   * 这同时也在验"规则只影响它点名的那一个动作"。
   */
  await page.evaluate(() => localStorage.setItem("dsh-canvas.confirm-mode", "按需确认"));
  await page.evaluate(async () => {
    const shell = window.shell;
    const cur = await shell.appSettings.read();
    await shell.appSettings.write({ ...cur, rules: [{ action: "spawn_agent", effect: "allow" }] });
  });
  out.rulesWrite = await page.evaluate(async () => { const cur = await window.shell.appSettings.read(); return cur; });
  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1200);

  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-composer-input"]').fill(
    `请调用 spawn_agent 工具。任务：请调用 memory_save 工具记住这一条：${KEY}`,
  );
  await page.locator('[data-testid="wb-send"]').click();

  /* 等父级步上出现**待批**行（子智能体冒泡出来的那条） */
  const deadline = Date.now() + 90_000;
  let allowButtons = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    allowButtons = await page.locator('[data-testid^="wb-tool-allow-"]').count();
    if (allowButtons > 0) break;
  }
  out.allowButtons = allowButtons;
  out.transcript = await page.evaluate(() => Array.from(document.querySelectorAll(".wb-assistant-text, .wb-assistant-tools")).map((e) => (e.textContent ?? "").trim().slice(0, 200)));
  out.pendingText = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-tool-line")).map((e) => (e.textContent ?? "").trim()),
  );
  out.shotBefore = await shot(page, "subagent-approval-before.png");
  out.logTail = (getLog() || "").slice(-600);

  /* 批准之前：磁盘上不该有那条（没有偷偷执行） */
  const memFile = path.join(DATA, "memory.json");
  out.beforeApprove = fs.existsSync(memFile) ? fs.readFileSync(memFile, "utf8").includes(KEY) : false;

  if (allowButtons > 0) {
    await page.locator('[data-testid^="wb-tool-allow-"]').first().click();
    /* 等磁盘真的写进去 */
    const dl = Date.now() + 20_000;
    while (Date.now() < dl) {
      await page.waitForTimeout(500);
      if (fs.existsSync(memFile) && fs.readFileSync(memFile, "utf8").includes(KEY)) break;
    }
  }
  out.afterApprove = fs.existsSync(memFile) ? fs.readFileSync(memFile, "utf8").includes(KEY) : false;
  out.shotAfter = await shot(page, "subagent-approval-after.png");
  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  await killTree(child);
  fake.close();
  console.log(JSON.stringify(out, null, 2));
  const bad = [];
  if (!(out.allowButtons > 0)) bad.push("没有出现待批行 —— 子智能体的 blocked 没有冒泡到父级");
  if (out.beforeApprove) bad.push("批准之前 memory.json 里就已经有那条 —— 闸门被绕过了");
  if (!out.afterApprove) bad.push("点了允许之后 memory.json 里仍然没有那条 —— 批准没有真的执行");
  if (out.error) bad.push("异常: " + out.error);
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 子智能体被拦下的动作冒泡成父级待批，批准后真的执行一次");
  }
}
