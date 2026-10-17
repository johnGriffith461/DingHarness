/**
 * **画布 MCP server 的验收**（V5-4 任务 4.5）：**当一次外部 MCP 客户端**。
 *
 * 判据就是方案那句话 —— "外部 MCP 客户端可驱动画布"：
 *
 * 1. 起 server（子进程，stdio）→ `initialize` 握手拿到 serverInfo；
 * 2. `tools/list` 看到画布工具（声明与 `canvasContract` 那张表一致）；
 * 3. `tools/call` 加一个节点 → 结果里带回节点 id；
 * 4. **读磁盘上的画布文档**：节点真在里面、revision 涨了（这一步是关键 ——
 *    不然"能调"只证明了协议，没证明画布真的被改了）；
 * 4b. **事件也落了盘**（C6 3.9a）：`canvas_events` 里有对应的 `node.create`，
 *    而且 `actor` 是 `mcp:<客户端名>`（"谁改的画布"要查得到）；
 * 5. 参数不合法时：回的是**工具层的结果**（`isError: true`）而不是协议错 ——
 *    与内核"错误即结果"同一个口径；
 * 6. 不认识的方法 → 协议错 `-32601`（协议层该守的规矩照守）。
 *
 * ⚠️ 它**不碰真画布**：数据目录是临时目录（`DH_DATA_DIR` 指向它），
 * 所以跑一百遍也不会动用户自己的那张画布。
 *
 * 用法：`pnpm verify:canvas-mcp`（退出码非零 = 有断言红）。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bad = [];
const ok = (cond, what) => {
  if (cond) {
    console.log(`  ✓ ${what}`);
    return;
  }
  bad.push(what);
  console.error(`  ✗ ${what}`);
};

const dataDir = mkdtempSync(path.join(os.tmpdir(), "dh-canvas-mcp-"));
const docFile = path.join(dataDir, "canvas", "document.json");

/*
 * 起 server：与外部客户端同一条路（子进程 + stdio + 一行一条 JSON-RPC）。
 * ⚠️ 用 `node <tsx 的 JS 入口>` 而不是 `.bin/tsx.cmd`：Node ≥20 拒绝直接 spawn `.cmd`
 * （EINVAL，实测），要么 `shell: true`（带参数转义告警），要么绕开 shim —— 绕开更干净。
 */
const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const server = spawn(process.execPath, [tsxCli, path.join(ROOT, "hosts/mcp/canvasServer.ts")], {
  cwd: ROOT,
  env: { ...process.env, DH_DATA_DIR: dataDir },
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
let nextId = 1;
let stdoutBuf = "";
server.stdout.on("data", (chunk) => {
  stdoutBuf += String(chunk);
  const lines = stdoutBuf.split("\n");
  stdoutBuf = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      bad.push(`server 的 stdout 里有非 JSON 输出：${trimmed.slice(0, 120)}（stdout 是协议通道，日志该走 stderr）`);
      continue;
    }
    const slot = pending.get(msg.id);
    if (slot) {
      pending.delete(msg.id);
      slot(msg);
    }
  }
});
let stderrText = "";
server.stderr.on("data", (d) => (stderrText += String(d)));

/** 发一条请求并等它的回应（超时给 5 秒 —— 挂住比红更坏）。 */
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`等 ${method} 的回应超时（server 还活着吗）\n${stderrText.slice(-400)}`)), 8000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

try {
  console.log(`画布 MCP 验收（临时数据目录 ${dataDir}）\n`);

  /* ① 握手 */
  const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify", version: "1" } });
  ok(init.result?.serverInfo?.name === "ding-canvas", `initialize 握手（serverInfo.name = ${init.result?.serverInfo?.name}）`);
  ok(init.result?.protocolVersion === "2024-11-05", "协议版本对得上");
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  /* ② 工具面 */
  const list = await call("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  ok(names.includes("canvas_add_node"), `tools/list 里有画布工具（${names.join(" / ")}）`);
  const schema = (list.result?.tools ?? []).find((t) => t.name === "canvas_add_node")?.inputSchema;
  ok(schema?.required?.includes("kind") && schema?.required?.includes("text"), "输入 schema 说了要什么（kind + text）");

  /* ③ 调一次：加一个 markdown 节点 */
  const added = await call("tools/call", { name: "canvas_add_node", arguments: { kind: "markdown", text: "# 来自 MCP 客户端" } });
  const text = added.result?.content?.[0]?.text ?? "";
  ok(added.result?.isError !== true && text.includes("已加到画布"), `tools/call 成功（${text.slice(0, 60)}）`);

  /* ④ 画布**真被改了**：读盘 */
  ok(existsSync(docFile), "画布文档落到了磁盘上（<数据目录>/canvas/document.json）");
  const doc = JSON.parse(readFileSync(docFile, "utf8"));
  ok(Array.isArray(doc.nodes) && doc.nodes.length === 1, `文档里真有 1 个节点（${doc.nodes?.length}）`);
  ok(doc.nodes?.[0]?.type === "markdown" && doc.nodes?.[0]?.data?.text?.includes("来自 MCP 客户端"), "节点内容与调用参数一致");
  ok(doc.revision === 1 && doc.confirmedRevision >= 1, `revision 涨到 ${doc.revision}（confirmed ${doc.confirmedRevision}）`);

  /* 再调一次 code 节点 —— 两次调用是累加的，不是覆盖 */
  const second = await call("tools/call", { name: "canvas_add_node", arguments: { kind: "code", text: "console.log(1)", lang: "js" } });
  ok(second.result?.isError !== true, "第二个节点也加上了");
  const doc2 = JSON.parse(readFileSync(docFile, "utf8"));
  ok(doc2.nodes.length === 2 && doc2.nodes[1].type === "code" && doc2.nodes[1].data.lang === "js", "两个节点都在，第二个是 code/js");

  /* ④b 事件也落了盘（C6 3.9a）：画布终于有账了 —— 谁在什么时候加了哪个节点 */
  const dbFile = path.join(dataDir, "sessions.db");
  ok(existsSync(dbFile), "事件库（sessions.db）在数据目录里");
  const db = new DatabaseSync(dbFile);
  try {
    const rows = db.prepare("SELECT seq, type, actor_id, actor_kind FROM canvas_events ORDER BY seq").all();
    const types = rows.map((r) => String(r.type));
    ok(types.includes("canvas.open") && types.filter((t) => t === "node.create").length === 2, `画布事件落了盘（${types.join(" / ")}）`);
    ok(
      rows.every((r) => String(r.actor_id) === "mcp:verify"),
      `事件的 actor 是发起这次调用的客户端（${String(rows[0]?.actor_id)}，C5：谁改的要查得到）`,
    );
    /* 文档与事件流对得上（派生缓存与真相一致） */
    ok(Number(db.prepare("SELECT current_revision AS r FROM canvases WHERE id = ?").get("canvas-default")?.r ?? 0) >= 2, "canvases 的修订位点跟着走");
  } finally {
    db.close();
  }

  /* ⑤ 参数不合法：工具层的结果（不是协议错） */
  const badKind = await call("tools/call", { name: "canvas_add_node", arguments: { kind: "image", text: "x" } });
  ok(badKind.error === undefined && badKind.result?.isError === true, "kind 不合法 → isError: true（错误即结果）");
  ok(String(badKind.result?.content?.[0]?.text ?? "").includes("kind 只支持"), `拒绝理由写清了（${String(badKind.result?.content?.[0]?.text ?? "").slice(0, 40)}）`);

  /* ⑥ 不认识的方法：协议错 -32601 */
  const unknown = await call("resources/list", {});
  ok(unknown.error?.code === -32601, `不认识的方法回 -32601（收到 ${JSON.stringify(unknown.error?.code)}）`);

  /* 节点没被上面那两次失败调用改坏 */
  const doc3 = JSON.parse(readFileSync(docFile, "utf8"));
  ok(doc3.nodes.length === 2, "失败的调用没有改动画布（还是 2 个节点）");
} catch (error) {
  bad.push(`异常：${String(error?.message ?? error).slice(0, 300)}`);
} finally {
  server.kill();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* 尽力而为 */
  }
}

console.log("");
if (bad.length) {
  console.error(`✗ 画布 MCP 验收有 ${bad.length} 条不过：\n${bad.map((b) => `  · ${b}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("✓ 画布 MCP 验收全过：外部客户端能驱动画布（真改了磁盘上那份文档）");
}
