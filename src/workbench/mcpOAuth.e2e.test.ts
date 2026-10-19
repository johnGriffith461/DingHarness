import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import type { McpServerConfig } from "@shared/mcp";
import { HttpMcpClient } from "../../electron/ipc/mcpClient";
import { McpOAuthFlow, type StoredOAuth, type TokenStore } from "../../electron/ipc/mcpOAuth";

/**
 * G4 端到端：**真的 HTTP**（不是 mock fetch）。
 *
 * 假服务器同时扮演资源服务器与授权服务器：401 带 `WWW-Authenticate` →
 * 发现元数据 → DCR → 手动授权码 → token 交换 → 重连后列工具 → 调工具成功。
 * 这条挡的是"OAuth 只在单测里成立、到了传输层没接上"。
 */

type Fake = {
  url: string;
  close: () => Promise<void>;
  /** 服务器真的收到了带 Bearer 的 tools/call */
  calls: Array<{ auth: string; tool: string }>;
};

async function fakeMcp(): Promise<Fake> {
  const calls: Fake["calls"] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
      return json(200, { authorization_servers: [origin], scopes_supported: ["mcp:read"] });
    }
    if (req.url === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
      });
    }
    if (req.url === "/register") {
      const body = JSON.parse(bodyText || "{}") as { redirect_uris?: string[] };
      expect(body.redirect_uris?.[0]).toContain("127.0.0.1");
      return json(200, { client_id: "e2e-client" });
    }
    if (req.url === "/token") {
      const params = new URLSearchParams(bodyText);
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("code")).toBe("good-code");
      expect((params.get("code_verifier") ?? "").length).toBeGreaterThanOrEqual(43);
      return json(200, { access_token: "tok-1", refresh_token: "ref-1", expires_in: 3600 });
    }
    if (req.url !== "/mcp") return json(404, { error: "not found" });

    const auth = req.headers.authorization ?? "";
    const message = JSON.parse(bodyText || "{}") as {
      id?: number | string;
      method?: string;
      params?: { name?: string; arguments?: unknown };
    };
    if (auth !== "Bearer tok-1") {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (message.method === "initialize") {
      return json(
        200,
        {
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } },
        },
        { "mcp-session-id": "sess-1" },
      );
    }
    if (message.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    if (message.method === "tools/list") {
      return json(200, {
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [{ name: "echo", description: "回显", inputSchema: { type: "object" } }] },
      });
    }
    if (message.method === "tools/call") {
      calls.push({ auth, tool: message.params?.name ?? "" });
      return json(200, {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "echo:hi" }] },
      });
    }
    return json(200, { jsonrpc: "2.0", id: message.id, result: {} });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function memoryStore(): TokenStore {
  const saved = new Map<string, StoredOAuth>();
  return {
    load: (name) => saved.get(name) ?? null,
    save: (name, token) => {
      saved.set(name, token);
      return { ok: true };
    },
    clear: (name) => {
      saved.delete(name);
    },
  };
}

let fake: Fake | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

describe("G4 端到端（真 HTTP）", () => {
  it("401 → 授权 → 重连 → 列工具 → 调工具", async () => {
    fake = await fakeMcp();
    const config: McpServerConfig = { name: "demo", url: fake.url };
    const flow = new McpOAuthFlow({ tokenStore: memoryStore(), timeoutMs: 5000 });
    const client = new HttpMcpClient(config, undefined, {
      oauth: { getToken: (force?: boolean) => flow.getToken("demo", force) },
    });

    /* 未授权：连接失败，且错误是可行动的"去点授权" */
    expect(await client.start()).toBe(false);
    expect(client.errorText()).toContain("需要授权");
    const hint = client.authHint();
    expect(hint?.resourceMetadata).toContain("oauth-protected-resource");

    /* 授权（假服务器 + 真回环 + 手动授权码，不真的开浏览器） */
    const begun = await flow.begin({ name: "demo", url: fake.url }, hint);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const done = await flow.complete(begun.state, "good-code");
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.token.accessToken).toBe("tok-1");

    /* 重连：这次带 Bearer，工具列表出来了 */
    expect(await client.start()).toBe(true);
    expect(client.toolList().map((t) => t.name)).toEqual(["echo"]);

    /* 调工具：服务器看到的是同一个 Bearer */
    const call = await client.call("echo", { text: "hi" });
    expect(call.ok).toBe(true);
    if (call.ok) expect(call.text).toContain("echo:hi");
    expect(fake.calls).toEqual([{ auth: "Bearer tok-1", tool: "echo" }]);
    client.stop();
  });

  it("回滚开关的语义：没有 OAuth 配置时 401 直接报 HTTP 401", async () => {
    fake = await fakeMcp();
    const client = new HttpMcpClient({ name: "demo", url: fake.url });
    expect(await client.start()).toBe(false);
    expect(client.errorText()).toContain("HTTP 401");
    client.stop();
  });
});
