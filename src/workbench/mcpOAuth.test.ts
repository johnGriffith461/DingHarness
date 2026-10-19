import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  McpOAuthFlow,
  base64url,
  parseWwwAuthenticate,
  pkcePair,
  type StoredOAuth,
  type TokenStore,
} from "../../electron/ipc/mcpOAuth";

/**
 * G4：OAuth 的纯逻辑与回环流程（不启 Electron）。
 *
 * 用一个假授权服务器驱动完整链路：发现元数据 → DCR → 授权 URL → 授权码交换 →
 * token 保存/刷新。这些断言挡的是：PKCE 写错、state 不校验、超时不收尸、刷新不落盘。
 */

function memoryStore(): TokenStore & { saved: Map<string, StoredOAuth> } {
  const saved = new Map<string, StoredOAuth>();
  return {
    saved,
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

function fakeAuthServer(overrides: { failRefresh?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("oauth-protected-resource")) {
      return json({ authorization_servers: ["https://auth.example"], scopes_supported: ["mcp:read", "mcp:write"] });
    }
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return json({
        issuer: "https://auth.example",
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
        registration_endpoint: "https://auth.example/register",
        scopes_supported: ["mcp:read"],
      });
    }
    if (url === "https://auth.example/register") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { redirect_uris?: string[] };
      expect(body.redirect_uris?.[0]).toContain("127.0.0.1");
      return json({ client_id: "client-1" });
    }
    if (url === "https://auth.example/token") {
      const params = new URLSearchParams(String(init?.body ?? ""));
      const grant = params.get("grant_type");
      if (grant === "refresh_token") {
        if (overrides.failRefresh) return new Response("nope", { status: 400 });
        return json({ access_token: "fresh-token", expires_in: 3600, refresh_token: "refresh-2" });
      }
      expect(grant).toBe("authorization_code");
      expect(params.get("code")).toBe("the-code");
      expect(params.get("client_id")).toBe("client-1");
      /* PKCE：verifier 必须是 43–128 个 base64url 字符（不能空） */
      const verifier = params.get("code_verifier") ?? "";
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
      return json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, token_type: "Bearer" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("PKCE 与鉴权头", () => {
  it("verifier 落在 43–128；challenge = base64url(SHA256(verifier))", () => {
    const pair = pkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.verifier.length).toBeLessThanOrEqual(128);
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    const expected = base64url(createHash("sha256").update(pair.verifier).digest());
    expect(pair.challenge).toBe(expected);
  });

  it("两次生成不重复", () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier);
  });

  it("从 WWW-Authenticate 取 resource_metadata 与 scope", () => {
    const got = parseWwwAuthenticate(
      'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource", scope="mcp:read"',
    );
    expect(got.resourceMetadata).toBe("https://mcp.example/.well-known/oauth-protected-resource");
    expect(got.scope).toBe("mcp:read");
  });
});

describe("授权流程（假服务器 + 真回环）", () => {
  it("发现 → DCR → 授权 URL → 授权码交换 → token 落库", async () => {
    const store = memoryStore();
    const flow = new McpOAuthFlow({ fetchImpl: fakeAuthServer(), tokenStore: store, timeoutMs: 5000 });
    const begun = await flow.begin(
      { name: "demo", url: "https://mcp.example/mcp" },
      { resourceMetadata: "https://mcp.example/.well-known/oauth-protected-resource" },
    );
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const url = new URL(begun.url);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(begun.state);
    expect(url.searchParams.get("resource")).toBe("https://mcp.example/mcp");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const result = await flow.complete(begun.state, "the-code");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token.accessToken).toBe("access-1");
    expect(result.token.refreshToken).toBe("refresh-1");
    expect(store.saved.get("demo")?.accessToken).toBe("access-1");
    expect(flow.status("demo").authorized).toBe(true);
    expect(flow.pendingCount()).toBe(0);
  });

  it("⭐ state 不匹配的回调被拒，流程仍可用手动授权码完成", async () => {
    const store = memoryStore();
    const flow = new McpOAuthFlow({ fetchImpl: fakeAuthServer(), tokenStore: store, timeoutMs: 5000 });
    const begun = await flow.begin(
      { name: "demo", url: "https://mcp.example/mcp" },
      { resourceMetadata: "https://mcp.example/.well-known/oauth-protected-resource" },
    );
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const redirect = new URL(begun.url).searchParams.get("redirect_uri")!;
    const bad = await fetch(`${redirect}?state=wrong&code=evil`);
    expect(bad.status).toBe(400);
    expect(flow.pendingCount()).toBe(1);
    const result = await flow.complete(begun.state, "the-code");
    expect(result.ok).toBe(true);
  });

  it("超时清掉 pending，返回可读错误", async () => {
    const store = memoryStore();
    const flow = new McpOAuthFlow({ fetchImpl: fakeAuthServer(), tokenStore: store, timeoutMs: 40 });
    const begun = await flow.begin(
      { name: "demo", url: "https://mcp.example/mcp" },
      { resourceMetadata: "https://mcp.example/.well-known/oauth-protected-resource" },
    );
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const result = await flow.wait(begun.state);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("超时");
    expect(flow.pendingCount()).toBe(0);
  });

  it("401 后强制刷新：拿到新 token 并落库；刷新失败不清空已有 token", async () => {
    const store = memoryStore();
    store.saved.set("demo", {
      accessToken: "old",
      refreshToken: "refresh-1",
      expiresAt: Date.now() - 1000,
      tokenEndpoint: "https://auth.example/token",
      clientId: "client-1",
      serverUrl: "https://mcp.example/mcp",
    });
    const flow = new McpOAuthFlow({ fetchImpl: fakeAuthServer(), tokenStore: store });
    expect(await flow.getToken("demo", true)).toBe("fresh-token");
    expect(store.saved.get("demo")?.accessToken).toBe("fresh-token");

    const failing = new McpOAuthFlow({ fetchImpl: fakeAuthServer({ failRefresh: true }), tokenStore: store });
    expect(await failing.getToken("demo", true)).toBeNull();
    /* 旧 token 仍在（界面仍显示"已授权/待刷新"，不会把工具清空） */
    expect(store.saved.get("demo")?.refreshToken).toBeTruthy();
  });
});
