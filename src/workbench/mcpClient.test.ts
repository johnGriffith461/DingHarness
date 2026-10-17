import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpClient } from "../../electron/ipc/mcpClient";
import { removeAll } from "../testFs";

/**
 * MCP 客户端 vs **一个真的假 server**（2026-10-14）。
 *
 * 为什么这一组值得存在：MCP 是**协议**，协议这种东西"看起来实现了"和"真的通"差得很远 ——
 * 传输写错（比如照 LSP 那样加 `Content-Length` 头）、握手顺序写错（漏掉
 * `notifications/initialized`）、id 对不上，任何一种都表现为"连不上"或"调用没反应"。
 * 所以这里**起一个真的子进程**说 JSON-RPC，端到端验握手、列工具、调用、出错与超时。
 *
 * ⚠️ 容器里有四种 server：正常 / 立刻退出 / 装死 / 往 stdout 打日志 —— 最后两种是最常见的
 * 真实故障形态（命令写错、依赖没装、server 把日志打到 stdout）。
 */
let ROOT = "";

/** 一个说 line-delimited JSON-RPC 的假 MCP server。 */
const FAKE_SERVER = `
let buf = "";
process.stdin.setEncoding("utf8");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, at).trim();
    buf = buf.slice(at + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0" } } });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
        { name: "echo", description: "把文本回显回来", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
        { name: "boom", description: "总是失败", inputSchema: { type: "object", properties: {} } },
      ] } });
    } else if (msg.method === "tools/call") {
      if (msg.params.name === "echo") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + (msg.params.arguments.text || "") }] } });
      else if (msg.params.name === "boom") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "坏了" }], isError: true } });
      else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "没有这个工具" } });
    }
  }
});
`;


/** 会变工具清单的 server（U04：验 `tools/list_changed` 真的触发重列）。 */
const MUTABLE_SERVER = `
let buf = "";
let extra = false;
process.stdin.setEncoding("utf8");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const list = () => (extra ? [{ name: "echo" }, { name: "added", description: "后来加的" }] : [{ name: "echo" }]);
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, at).trim();
    buf = buf.slice(at + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "m", version: "1" } } });
    else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: list() } });
    else if (msg.method === "tools/call") {
      if (msg.params.name === "reload") {
        extra = true;
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "changed" }] } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
      }
    }
  }
});
`;

beforeAll(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "mcptool-"));
  fs.writeFileSync(path.join(ROOT, "fake.mjs"), FAKE_SERVER, "utf8");
  /* 会变清单的 server（U04） */
  fs.writeFileSync(path.join(ROOT, "mutable.mjs"), MUTABLE_SERVER, "utf8");
  /* 立刻退出（命令写错/依赖没装的样子） */
  fs.writeFileSync(path.join(ROOT, "die.mjs"), "process.exit(3);\n", "utf8");
  /* 装死：收东西但永不回话（超时路径） */
  fs.writeFileSync(path.join(ROOT, "hang.mjs"), "process.stdin.resume();\n", "utf8");
  /* 往 stdout 先打一行日志（很多真 server 这么干），再正常服务 */
  fs.writeFileSync(
    path.join(ROOT, "noisy.mjs"),
    `process.stdout.write("starting up...\\n");\n${FAKE_SERVER}`,
    "utf8",
  );
});

afterAll(() => {
  removeAll(ROOT);
});

const cfg = (file: string, name = "fake") => ({ name, command: process.execPath, args: [path.join(ROOT, file)] });
const fast = { handshakeMs: 3000, callMs: 3000 };

describe("握手 → 列工具 → 调用", () => {
  it("⭐ 连得上，并且把服务端的工具连同 schema 拿到手", async () => {
    const client = new McpClient(cfg("fake.mjs"), fast);
    const ok = await client.start();
    expect(ok, client.errorText()).toBe(true);
    expect(client.status()).toBe("on");
    const tools = client.toolList();
    expect(tools.map((t) => t.name)).toEqual(["echo", "boom"]);
    expect(tools[0].description).toBe("把文本回显回来");
    /* schema 是原样带回来的（不重新描述一遍） */
    expect(tools[0].inputSchema).toMatchObject({ type: "object" });
    client.stop();
  }, 20000);

  it("⭐ 调得通（参数真的发到了服务端）", async () => {
    const client = new McpClient(cfg("fake.mjs"), fast);
    await client.start();
    const res = await client.call("echo", { text: "你好" });
    /* G19：结果被标成不可信块（连接器返回的是数据，不是指令），正文仍在里面 */
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain("echo:你好");
    expect(res.text).toContain("[untrusted: 连接器");
    expect(res.isError).toBe(false);
    client.stop();
  }, 20000);

  it("服务端把工具标成失败 → 我们如实带回来（不当成成功）", async () => {
    const client = new McpClient(cfg("fake.mjs"), fast);
    await client.start();
    const res = await client.call("boom", {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.isError).toBe(true);
    expect(res.text).toContain("坏了");
    client.stop();
  }, 20000);

  it("JSON-RPC 层的错误 → 一句话说清（Factor 9：不抛异常）", async () => {
    const client = new McpClient(cfg("fake.mjs"), fast);
    await client.start();
    const res = await client.call("没有这个", {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("没有这个工具");
    client.stop();
  }, 20000);

  it("stdout 上先来一行日志也不影响（很多真 server 这么干）", async () => {
    const client = new McpClient(cfg("noisy.mjs", "noisy"), fast);
    const ok = await client.start();
    expect(ok, client.errorText()).toBe(true);
    const res = await client.call("echo", { text: "x" });
    expect(res.ok && res.text.includes("echo:x")).toBe(true);
    client.stop();
  }, 20000);
});

describe("坏掉的时候", () => {
  it("⭐ 进程立刻退出 → 连不上，并且**带着原因**（退出码）", async () => {
    const client = new McpClient(cfg("die.mjs", "die"), fast);
    const ok = await client.start();
    expect(ok).toBe(false);
    expect(client.status()).toBe("error");
    expect(client.errorText()).toMatch(/退出|断开|超时/);
    client.stop();
  }, 20000);

  it("⭐ 装死（不回话）→ 超时，不是永远挂着", async () => {
    const client = new McpClient(cfg("hang.mjs", "hang"), fast);
    const ok = await client.start();
    expect(ok).toBe(false);
    expect(client.errorText()).toContain("超时");
    client.stop();
  }, 25000);

  it("没连上就调用 → 明确拒绝（不是静默返回空）", async () => {
    const client = new McpClient(cfg("die.mjs", "die"), fast);
    await client.start();
    const res = await client.call("echo", { text: "x" });
    expect(res.ok).toBe(false);
  }, 20000);

  it("停掉之后再调用 → 也拒绝", async () => {
    const client = new McpClient(cfg("fake.mjs"), fast);
    await client.start();
    client.stop();
    const res = await client.call("echo", { text: "x" });
    expect(res.ok).toBe(false);
  }, 20000);
});

/* ============================================================
 * U04：tools/list_changed（服务端换了清单要真的重列）
 * ============================================================ */
describe("工具清单热更新（U04）", () => {
  it("⭐ 服务端发 list_changed → 重列工具，并通过回调告诉宿主", async () => {
    let seen: string[] = [];
    const client = new McpClient(cfg("mutable.mjs", "mutable"), fast, {
      onToolsChanged: (tools) => {
        seen = tools.map((t) => t.name);
      },
    });
    await client.start();
    expect(client.toolList().map((t) => t.name)).toEqual(["echo"]);
    const res = await client.call("reload", {});
    expect(res.ok).toBe(true);
    /* 通知是异步处理的：等一小会儿再看 */
    for (let i = 0; i < 20 && seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(["echo", "added"]);
    expect(client.toolList().map((t) => t.name)).toEqual(["echo", "added"]);
    client.stop();
  }, 20000);
});
