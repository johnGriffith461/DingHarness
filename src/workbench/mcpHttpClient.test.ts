import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HttpMcpClient } from "../../electron/ipc/mcpClient";

/**
 * **streamable HTTP 的 MCP 客户端**（U04，2026-10-18）。
 *
 * 这一组用一个**真的** HTTP 服务（回环、脚本化回包）验四件事：
 * ① 握手 + 会话 id；② `application/json` 与 `text/event-stream` 两种回包；
 * ③ 非文本内容落盘（图片 → 文件 + 回注路径）；④ 会话过期（404）自动重新握手。
 */

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** 起一个脚本化的 MCP HTTP 服务；返回端点与会话使用记录。 */
async function fakeMcp(): Promise<{
  url: string;
  seen: { sessions: (string | undefined)[]; calls: number };
}> {
  const seen: { sessions: (string | undefined)[]; calls: number } = { sessions: [], calls: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body) as { id?: number; method?: string; params?: { name?: string } };
      if (msg.method === "notifications/initialized") {
        seen.sessions.push(req.headers["mcp-session-id"] as string | undefined);
        res.writeHead(202).end();
        return;
      }
      if (msg.method === "initialize") {
        const session = "s-1";
        seen.sessions.push(req.headers["mcp-session-id"] as string | undefined);
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": session });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake" } },
          }),
        );
        return;
      }
      if (msg.method === "tools/list") {
        seen.sessions.push(req.headers["mcp-session-id"] as string | undefined);
        /* 这一条用 SSE 回（规范允许），验第二种回包形态 */
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { tools: [{ name: "shot", description: "截一张", inputSchema: { type: "object" } }] },
          })}\n\n`,
        );
        res.end();
        return;
      }
      if (msg.method === "tools/call") {
        seen.calls += 1;
        /* 第一次调用装作会话过期（404），客户端应重新握手再来一次 */
        if (seen.calls === 1) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [
                { type: "text", text: "截好了" },
                /* 1x1 PNG */
                { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
              ],
            },
          })}\n\n`,
        );
        /* 同一帧后面跟一条通知：客户端应该看出来并重列工具 */
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/mcp`, seen };
}

describe("HttpMcpClient（streamable HTTP）", () => {
  it("⭐ 握手 → 列工具（SSE 回包）→ 调用；会话 id 带上", async () => {
    const { url, seen } = await fakeMcp();
    const attachments = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-mcp-att-"));
    dirs.push(attachments);
    const client = new HttpMcpClient({ name: "remote", url }, undefined, { attachmentsDir: attachments });
    expect(await client.start()).toBe(true);
    expect(client.status()).toBe("on");
    expect(client.toolList().map((t) => t.name)).toEqual(["shot"]);
    /* 第一次调用 404（模拟会话过期）→ 自动重新握手再试一次 */
    const got = await client.call("shot", {});
    expect(got.ok, got.ok ? "" : got.error).toBe(true);
    if (!got.ok) return;
    expect(got.text).toContain("截好了");
    /* 图片落成了文件，回注里给了路径 */
    const match = got.text.match(/已保存到 (.+?)）/);
    expect(match, `回注里没有落盘路径：${got.text.replace(/\n/g, " | ")}`).toBeTruthy();
    expect(fs.existsSync(match![1]!)).toBe(true);
    /* 404 之后的重新握手确实带了会话头 */
    expect(seen.sessions.filter((s) => s === "s-1").length).toBeGreaterThan(0);
  });

  it("连不上时给一句人话（不抛、不把状态留在 starting）", async () => {
    const client = new HttpMcpClient({ name: "dead", url: "http://127.0.0.1:1/mcp" }, { handshakeMs: 1, callMs: 500 });
    expect(await client.start()).toBe(false);
    expect(client.status()).toBe("error");
    expect(client.errorText().length).toBeGreaterThan(0);
  });

  it("配置里没有 url → 不装死，直接说原因", async () => {
    const client = new HttpMcpClient({ name: "nourl" });
    expect(await client.start()).toBe(false);
    expect(client.errorText()).toContain("url");
  });
});
