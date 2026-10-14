import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**连接器（MCP）接得上、工具交给模型、调用真回到服务端**（2026-10-14）。
 *
 * ## 为什么这条重要
 * goose 的 README 写着"70+ extensions via MCP"、opencode 把 MCP server 列为第二种工具来源 ——
 * 而在这之前我们一个外部工具都接不进来。这条脚本就是来钉"接得进来"这件事的：
 * 它起一个**真的**假 MCP server（子进程、说 line-delimited JSON-RPC），
 * 让应用去连、去列工具、去调用，然后从**两个方向**看结果：
 *   · 服务端真收到了调用（返回值里有服务端拼的字符串）；
 *   · 会话日志里这一轮下发给模型的工具清单里**有 `mcp__fake__echo`**。
 *
 * ## 八条断言
 * ① 连接器页签显示「已连接 · 提供 2 个工具」
 * ② 两个工具的本机名字是 `mcp__fake__echo` / `mcp__fake__boom`（前缀是闸门判断的依据）
 * ③ 走应用的 `ai:runTool` 真调一次 → 拿到服务端拼的 `echo:…`
 * ④ 服务端把工具标成失败时，我们**如实返回失败**（不当成功）
 * ⑤ 调一个不存在的工具 → 服务端报错被**带回来**（不抛异常、不静默）
 * ⑥ 这一轮下发给模型的工具清单里有连接器工具
 * ⑦ 配置文件路径显示出来了（用户要知道去哪加连接器）
 * ⑧ 「重新连接」之后仍然连得上（重连不是摆设）
 */
const DATA = ".verify/mcp-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

/* 夹具：一个真的假 MCP server（一行一条 JSON-RPC） */
const SERVER = path.join(DATA, "fake-mcp.mjs");
fs.writeFileSync(
  SERVER,
  `let buf = "";
process.stdin.setEncoding("utf8");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, at).trim();
    buf = buf.slice(at + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "echo", description: "回显（验收夹具）", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      { name: "boom", description: "总是失败（验收夹具）", inputSchema: { type: "object", properties: {} } }
    ] } });
    else if (msg.method === "tools/call") {
      if (msg.params.name === "echo") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + (msg.params.arguments.text || "") }] } });
      else if (msg.params.name === "boom") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "夹具故意失败" }], isError: true } });
      else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "没有这个工具" } });
    }
  }
});
`,
  "utf8",
);

/* 预置连接器配置（等价于用户手写了 mcp.json，然后点了「重新连接」） */
fs.writeFileSync(
  path.join(DATA, "mcp.json"),
  JSON.stringify(
    { __schema: 1, data: { servers: [{ name: "fake", command: process.execPath, args: [SERVER] }] } },
    null,
    2,
  ),
  "utf8",
);

const PORT = 9318;
const out = {};
let child = null;

try {
  const booted = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  child = booted.child;
  if (!booted.ok) {
    console.error("[诊断] 应用输出尾部：\n" + (booted.getLog() || "(空)").slice(-1200));
    process.exit(1);
  }

  const b = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  /* ── ①②⑦ 连接器页签 ── */
  await page.locator('[data-testid="wb-nav-plugins"]').click();
  await page.waitForTimeout(800);
  await page.locator('[data-testid="wb-plugin-manage"]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-manage-tab-连接器"]').click();
  await page.waitForTimeout(1200);

  out.statusLine = await page.locator('[data-testid="wb-mcp-line-fake"]').textContent().catch(() => null);
  out.toolNames = await page.locator('[data-testid="wb-mcp-tools-fake"]').textContent().catch(() => null);
  out.configShown = await page.locator('[data-testid="wb-mcp-file"]').textContent().catch(() => null);
  out.emptyShown = await page.locator('[data-testid="wb-manage-empty"]').count();
  out.shot = await shot(page, "mcp-connectors.png");

  /* ── ③④⑤ 真调一次（走"用户批准"那条通道）── */
  const callTool = (name, input) =>
    page.evaluate(
      ([n, i]) =>
        globalThis.shell.ai.runTool({ name: n, input: i, toolPolicy: "全部允许" }).then((r) => ({
          ran: r?.ok,
          ok: r?.output?.ok,
          line: r?.line,
          text: r?.output?.text,
          error: r?.error ?? r?.output?.error,
        })),
      [name, input],
    );

  out.echo = await callTool("mcp__fake__echo", { text: "你好连接器" });
  out.boom = await callTool("mcp__fake__boom", {});
  /*
   * ⑤ 名字形状对、但**不在服务端公布的清单里** → 我们明确拒绝，不把它转出去。
   * （"服务端自己报错"那条路走不通：名单就是这么来的 —— 那条路由单测覆盖：
   * `mcpClient.test.ts` 里直接 `call("没有这个")` 验过 JSON-RPC 的 error 会被带回来。）
   */
  out.missing = await callTool("mcp__fake__nope", {});

  /* ── ⑥ 这一轮下发给模型的工具清单里有没有连接器工具 ── */
  /* ⚠️ 输入区只在工作台上 —— 上一步的界面停在插件页，先回首页（否则这里点不到，超时 30 秒） */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(800);
  const input = page.locator('[data-testid="wb-composer-input"]');
  await input.click();
  await input.fill("随便说一句话（只为让这一轮请求落进会话日志）");
  await page.locator('[data-testid="wb-send"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="wb-send-stop"]'), { timeout: 25000 });
  await page.waitForTimeout(1200);

  const dir = path.join(DATA, "sessions");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
  out.sessionFiles = files;
  let toolsOffered = null;
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.type === "request" && Array.isArray(rec.tools)) toolsOffered = rec.tools;
    }
  }
  out.toolsOffered = toolsOffered;

  /* ── ⑧ 重新连接 ── */
  await page.locator('[data-testid="wb-nav-plugins"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-plugin-manage"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="wb-manage-tab-连接器"]').click();
  await page.waitForTimeout(1000);
  await page.locator('[data-testid="wb-mcp-reload"]').click();
  await page.waitForTimeout(2500);
  out.afterReload = await page.locator('[data-testid="wb-mcp-line-fake"]').textContent().catch(() => null);

  await b.close();
} catch (e) {
  out.error = String(e).split("\n")[0];
} finally {
  console.log(JSON.stringify(out, null, 2));
  if (child) await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  /* ①②⑦ */
  if (!String(out.statusLine ?? "").includes("已连接")) bad.push(`① 连接器状态不对：${JSON.stringify(out.statusLine)}`);
  if (!String(out.statusLine ?? "").includes("2 个工具")) bad.push(`① 没报出工具数：${JSON.stringify(out.statusLine)}`);
  for (const name of ["mcp__fake__echo", "mcp__fake__boom"]) {
    if (!String(out.toolNames ?? "").includes(name)) bad.push(`② 界面上没列出 ${name}：${JSON.stringify(out.toolNames)}`);
  }
  if (!String(out.configShown ?? "").includes("mcp.json")) bad.push(`⑦ 没显示配置文件路径：${JSON.stringify(out.configShown)}`);
  if (out.emptyShown !== 0) bad.push("① 已经配了连接器，却还显示空态");

  /* ③④⑤ */
  if (!out.echo?.ran) bad.push("③ 调用根本没跑到（ai:runTool 失败）");
  if (out.echo?.text !== "echo:你好连接器") bad.push(`③ 服务端的回答没回来：${JSON.stringify(out.echo?.text)}`);
  if (!String(out.echo?.line ?? "").includes("连接器已执行")) bad.push(`③ 留痕那句话不对：${JSON.stringify(out.echo?.line)}`);
  if (out.boom?.text !== "夹具故意失败") bad.push(`④ 失败的返回值不对：${JSON.stringify(out.boom?.text)}`);
  if (!String(out.boom?.line ?? "").includes("连接器报错")) bad.push(`④ 服务端标的失败没在留痕里如实写出来：${JSON.stringify(out.boom?.line)}`);
  if (!String(out.missing?.error ?? "").includes("不可用")) bad.push(`⑤ 清单外的工具没被明确拒绝：${JSON.stringify(out.missing)}`);

  /* ⑥ */
  if (!Array.isArray(out.toolsOffered)) bad.push("⑥ 会话日志里没有这一轮的工具清单");
  else if (!out.toolsOffered.includes("mcp__fake__echo")) {
    bad.push(`⑥ ⭐ 这一轮没把连接器工具交给模型：${JSON.stringify(out.toolsOffered)}`);
  }

  /* ⑧ */
  if (!String(out.afterReload ?? "").includes("已连接")) bad.push(`⑧ 重连之后没连上：${JSON.stringify(out.afterReload)}`);

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log(
      "✓ 连接器成立：装上就自动连 / 工具带前缀交给模型 / 调用真回到服务端（成功与失败都如实带回）/ 能重连",
    );
  }
}
