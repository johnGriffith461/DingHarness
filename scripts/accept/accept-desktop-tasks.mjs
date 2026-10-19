import { chromium } from "playwright";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  NO_PAGE_HINT,
  autoConfirmDialogs,
  readAllSessionRecords,
  bootApp,
  connectWithRetry,
  finishedTurns,
  freshDir,
  killTree,
  shot,
  waitForPage,
  waitTurnEnd,
} from "./harness.mjs";

/**
 * 验收：**T1 十任务里的 6/7/8**（桌面能力，真应用）。
 *
 * - **6 浏览器预览**：`shell.preview.open` 开本机页 → 真的多一个窗口；外网地址必须被拒。
 * - **7 浏览器 agent**：真模型在真应用里被要求"用浏览器工具填表并提交"，
 *   然后在页面里核对结果文本。**只有真模型 + 真窗口才能证明这条链路通。**
 * - **8 CUA**：默认关 → 显式开启 → 截图有真实尺寸 → 留痕有记录。
 *
 * ## 为什么 7 要真模型
 *
 * 浏览器那六条工具只注册在**桌面**（`electron/ipc/tools.ts`），
 * 由模型在对话里调用。不用真模型就只能测"工具表里有这几条"——
 * 那证明不了"模型能看懂快照、能挑对 ref、能点对按钮"。
 */
const DATA = ".verify/desktop-tasks-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const MODEL = process.env.ACCEPT_MODEL ?? "deepseek-v4.1-flash-1017";
const PROVIDER = process.env.ACCEPT_PROVIDER ?? "tokenrhythm";
const PORT = 9377;
const out = {};
let child = null;
/** 自动回答确认框的轮询（在 try 外声明，finally 才看得见） */
let autoConfirm = null;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>验收页</title></head>
<body style="font-family:sans-serif;padding:24px">
  <h1>联系表单</h1>
  <label>姓名 <input id="name" name="name"></label><br><br>
  <label>留言 <input id="note" name="note"></label><br><br>
  <button id="send" onclick="document.getElementById('done').textContent='已提交：'+document.getElementById('name').value">提交</button>
  <p id="done"></p>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE_HTML);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/form`;

/* 真 key：只读用户已有凭据，不打印 */
const apiKey = (() => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  for (const file of [path.join(home, ".ding", ".credentials.yaml"), path.join(home, ".dsh", ".credentials.yaml")]) {
    if (!fs.existsSync(file)) continue;
    const m = /^\s*A_API_KEY:\s*(\S+)/m.exec(fs.readFileSync(file, "utf8"));
    if (m) return m[1];
  }
  return "";
})();

try {
  const first = await bootApp({
    port: PORT,
    dataDir: DATA,
    timeoutMs: 30000,
    ...(apiKey ? { extraEnv: { A_API_KEY: apiKey } } : {}),
  });
  child = first.child;
  if (!first.ok) throw new Error("启动失败：" + (first.getLog() || "").slice(-800));
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(browser);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  /* 验收里自动回答应用内确认框（真用户仍要自己点；这里只是把点击交给脚本） */
  autoConfirm = autoConfirmDialogs(page);

  /* ── 6 浏览器预览 ── */
  out.previewLocal = await page.evaluate(async (url) => globalThis.shell.preview.open(url), pageUrl);
  await page.waitForTimeout(1500);
  out.previewWindowCount = browser.contexts().reduce((n, c) => n + c.pages().length, 0);
  out.previewRemoteRejected = await page.evaluate(async () => globalThis.shell.preview.open("https://example.com/"));
  await shot(page, ".verify/desktop-preview.png");

  /* ── 7 浏览器 agent（真模型） ── */
  if (!apiKey) {
    out.agentSkipped = "本机没有 A_API_KEY —— 这一条要真模型，跳过并如实记";
  } else {
    const before = await finishedTurns(page);
    /* 设定路由：provider/model（与 T0 声明的同一个） */
    /* 路由存在 localStorage（与输入区那颗模型 chip 同一份） */
    await page.evaluate(
      ([provider, model]) => {
        localStorage.setItem("dsh-canvas.chat-settings", JSON.stringify({ provider, model }));
        /* 验收必须无人值守：档位设成「全部允许」，否则浏览器工具会停在等审批 */
        localStorage.setItem("dsh-canvas.confirm-mode", "全部允许");
      },
      [PROVIDER, MODEL],
    );
    await page.locator("textarea").first().fill(
      `用浏览器工具打开 ${pageUrl} ，在"姓名"和"留言"里各填一个词（姓名填"阿洁"），然后点"提交"按钮。` +
        `做完后告诉我页面上显示的提交结果文本。`,
    );
    await page.keyboard.press("Enter");
    try {
      await waitTurnEnd(page, before, 240_000);
      out.agentTurnFinished = true;
    } catch (error) {
      out.agentTurnFinished = false;
      out.agentError = String(error).slice(0, 200);
    }
    await shot(page, ".verify/desktop-agent.png");
    /* 把模型实际调了什么记下来：红的时候要能说清是它没做对、还是我们没判对 */
    try {
      const records = await readAllSessionRecords(page);
      out.agentToolCalls = records
        .filter((r) => r.type === "tool-call" || r.type === "tool-result" || r.type === "tool-error")
        .map((r) => ({ type: r.type, name: r.name, input: r.input, error: r.error }))
        .slice(-12);
    } catch {
      out.agentToolCalls = [];
    }

    /* **判产物**：在 agent 那个窗口里读页面上的结果文本 —— 不是看模型说了什么 */
    await page.waitForTimeout(1500);
    /*
     * ⚠️ **有两个窗口的 URL 都含 /form**：6 那条开的预览窗口，和 agent 自己开的那个。
     * 只取第一个会读到没被填的预览页（实测踩到：独立诊断里明明成功了，这里却判红）。
     * 所以逐个看，**任一个**显示已提交即算过 —— 那正是"agent 真的动手了"的证据。
     */
    const targets = browser
      .contexts()
      .flatMap((c) => c.pages())
      .filter((p) => p.url().includes("/form"));
    out.agentPageFound = targets.length > 0;
    out.agentFormWindows = targets.length;
    for (const candidate of targets) {
      const state = await candidate
        .evaluate(() => ({
          done: document.getElementById("done")?.textContent ?? "",
          name: document.getElementById("name")?.value ?? "",
        }))
        .catch(() => ({ done: "", name: "" }));
      if (state.done.includes("已提交")) {
        out.agentDoneText = state.done;
        out.agentNameValue = state.name;
        break;
      }
    }
    out.agentSubmitted = String(out.agentDoneText ?? "").includes("已提交");
  }
  /* ── 8 CUA（放最后：它会弹应用内确认框，会挡住后面的操作） ── */
  out.cuaStatusBefore = await page.evaluate(async () => globalThis.shell.computer.status());
  /* 授权走应用内确认框；点击由 autoConfirm 代劳（验收不需要人守在这里） */
  out.cuaEnabled = await page.evaluate(async () => globalThis.shell.computer.enable());
  out.cuaDialogInDom = true;
  await page.waitForTimeout(400);
  out.cuaShot = await page.evaluate(async () => {
    const r = await globalThis.shell.computer.screenshot();
    return r.ok ? { ok: true, width: r.width, height: r.height, hasData: Boolean(r.dataUrl) } : r;
  });
  out.cuaLog = await page.evaluate(async () => {
    const rows = await globalThis.shell.computer.log();
    return { count: rows.length, lastAction: rows.at(-1)?.action ?? null };
  });
  /* 用完关掉，不留着一个开着的强权限开关 */
  await page.evaluate(async () => globalThis.shell.computer.disable());
} finally {
  autoConfirm?.stop();
  if (child) await killTree(child);
  await new Promise((resolve) => server.close(resolve));
}

const checks = [
  ["6 本机地址能打开预览", out.previewLocal?.ok === true],
  ["6 预览真的多了一个窗口", (out.previewWindowCount ?? 0) >= 2],
  ["6 外网地址被拒（只允许本机）", out.previewRemoteRejected?.ok === false],
  ["8 CUA 默认是关的（安全默认）", out.cuaStatusBefore?.enabled === false],
  ["8 授权走应用内确认框（不是系统弹窗）", out.cuaDialogInDom === true],
  ["8 能显式开启", out.cuaEnabled?.ok === true],
  ["8 截图返回了真实尺寸", out.cuaShot?.ok === true && (out.cuaShot?.width ?? 0) > 0],
  ["8 动作留痕有记录", (out.cuaLog?.count ?? 0) > 0],
  ["7 真模型那一轮跑完了", out.agentTurnFinished === true],
  ["7 agent 浏览器真的打开了那个页面", out.agentPageFound === true],
  ["7 表单真的被填并提交（页面文本变了）", out.agentSubmitted === true],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? "✓" : "✗"} ${name}\n`);
}
if (out.agentSkipped) process.stdout.write(`⚠️ ${out.agentSkipped}\n`);
process.stdout.write("\n" + JSON.stringify(out, null, 2).slice(0, 3000) + "\n");
process.stdout.write(`\n${failed === 0 ? "✓ 全部通过" : `✗ ${failed} 项未通过`}（${checks.length} 项）\n`);
process.exit(failed === 0 ? 0 : 1);
