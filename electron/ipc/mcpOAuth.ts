import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * MCP OAuth（G4）—— 只覆盖 **HTTP/SSE 传输**的授权码 + PKCE。
 *
 * ## 为什么单独一个文件
 *
 * `mcpClient.ts` 是传输层；OAuth 是一段**有状态的交互**（回环服务器、浏览器、
 * 回调、刷新），混进传输层会让那条本来就长的 `post()` 更难看清。
 * 这里不 import electron：浏览器打开与凭据落盘都由宿主注入，
 * 所以 PKCE/回环/超时/刷新能在 vitest 里直接测。
 *
 * ## 不做的事（如实写清）
 *
 * - **不做** sampling / elicitation（MCP 2025-06-18 的新反向调用面）；
 * - **不做** 设备码（device authorization）与非浏览器环境；
 * - 只认标准 `WWW-Authenticate` / RFC 8414 元数据；非标准实现暴露为可读错误。
 *
 * ## PKCE
 *
 * `code_verifier` 43–128 个字符；这里用 48 字节随机 → base64url = 64 字符。
 * `code_challenge = BASE64URL(SHA256(verifier))`，`code_challenge_method=S256`。
 */

export type PkcePair = { verifier: string; challenge: string };

export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 生成一对 PKCE（verifier 64 字符，落在规范要求的 43–128 内）。 */
export function pkcePair(random: (n: number) => Buffer = (n) => randomBytes(n)): PkcePair {
  const verifier = base64url(random(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export type ProtectedResourceMetadata = {
  authorizationServers: string[];
  scopesSupported?: string[];
};

export type AuthServerMetadata = {
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
};

/** 从 `WWW-Authenticate` 里取 `resource_metadata` 与 `scope`（大小写不敏感）。 */
export function parseWwwAuthenticate(header: string | null | undefined): { resourceMetadata?: string; scope?: string } {
  const text = String(header ?? "");
  const pick = (name: string): string | undefined => {
    const re = new RegExp(`${name}\\s*=\\s*"([^"]+)"`, "i");
    return re.exec(text)?.[1];
  };
  const resourceMetadata = pick("resource_metadata");
  const scope = pick("scope");
  return {
    ...(resourceMetadata ? { resourceMetadata } : {}),
    ...(scope ? { scope } : {}),
  };
}

export type StoredOAuth = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenEndpoint: string;
  clientId: string;
  scope?: string;
  serverUrl: string;
};

export type TokenStore = {
  load: (serverName: string) => StoredOAuth | null;
  save: (serverName: string, token: StoredOAuth) => { ok: true } | { ok: false; error: string };
  clear: (serverName: string) => void;
};

export type OAuthDeps = {
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  now?: () => number;
  tokenStore: TokenStore;
  /** 5 分钟超时（规范建议的回环窗口；测试可调小）。 */
  timeoutMs?: number;
  random?: (n: number) => Buffer;
};

export type BeginResult =
  | { ok: true; url: string; state: string }
  | { ok: false; error: string };

export type AuthorizeResult =
  | { ok: true; token: StoredOAuth; persisted: boolean; persistError?: string }
  | { ok: false; error: string };

type Pending = {
  serverName: string;
  serverUrl: string;
  clientId: string;
  tokenEndpoint: string;
  redirectUri: string;
  verifier: string;
  scope?: string;
  createdAt: number;
  settled: boolean;
  server: Server;
  done: Promise<AuthorizeResult>;
  resolve: (result: AuthorizeResult) => void;
};

const CALLBACK_PATH = "/callback";

/**
 * 一次授权流程的**宿主无关**实现。
 *
 * 生命周期：`begin()` 起回环并返回授权 URL → 浏览器回调（或手动 `complete()`）
 * → `finish()` 换 token 并保存 → `wait()` 拿到结果。
 */
export class McpOAuthFlow {
  private readonly pending = new Map<string, Pending>();
  private readonly cache = new Map<string, StoredOAuth>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: OAuthDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? 5 * 60_000;
  }

  /** 已保存 token 的授权状态（界面按钮用）。 */
  status(serverName: string): { authorized: boolean; expiresAt?: number } {
    const token = this.cached(serverName);
    if (!token) return { authorized: false };
    const valid = token.expiresAt === undefined || token.expiresAt - 60_000 > this.now();
    return { authorized: valid || Boolean(token.refreshToken), ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}) };
  }

  /**
   * 取一个可用于 `Authorization` 的 token。
   *
   * @param forceRefresh `true` = 上一次拿到 401，强制刷新一次
   * @returns `null` = 没有授权/刷新失败（调用方显示"需要授权"）
   */
  async getToken(serverName: string, forceRefresh = false): Promise<string | null> {
    let token = this.cached(serverName);
    if (!token) return null;
    const expiring = token.expiresAt !== undefined && token.expiresAt - 60_000 <= this.now();
    if (forceRefresh || expiring) {
      const refreshed = await this.refreshToken(serverName, token);
      if (!refreshed) return forceRefresh ? null : token.accessToken;
      token = refreshed;
    }
    return token.accessToken;
  }

  /**
   * 开始授权：发现元数据 → （必要时）动态注册 → 起回环 → 返回授权 URL。
   *
   * 不在这里等回调 —— 宿主可以先打开浏览器/把链接显示给用户；
   * 等待用 `wait(state)`（loopback 成功时它自己会完成）。
   */
  async begin(
    server: { name: string; url: string; scope?: string; clientId?: string },
    hint?: { resourceMetadata?: string; scope?: string },
  ): Promise<BeginResult> {
    try {
      const metadata = await this.discover(server.url, hint?.resourceMetadata);
      const scope = server.scope ?? hint?.scope;
      const { server: http, port } = await this.listen();
      const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
      const clientId =
        server.clientId ??
        (await this.registerClient(metadata, redirectUri)) ??
        "";
      if (!clientId) {
        http.close();
        return { ok: false, error: "授权服务器没有开放动态注册，且配置里没有 clientId" };
      }
      const { verifier, challenge } = pkcePair(this.deps.random);
      const state = base64url((this.deps.random ?? randomBytes)(16));
      const url = new URL(metadata.authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("state", state);
      url.searchParams.set("resource", server.url);
      if (scope) url.searchParams.set("scope", scope);

      let resolveDone: (result: AuthorizeResult) => void = () => undefined;
      const done = new Promise<AuthorizeResult>((resolve) => {
        resolveDone = resolve;
      });
      const pending: Pending = {
        serverName: server.name,
        serverUrl: server.url,
        clientId,
        tokenEndpoint: metadata.tokenEndpoint,
        redirectUri,
        verifier,
        ...(scope ? { scope } : {}),
        createdAt: this.now(),
        settled: false,
        server: http,
        done,
        resolve: resolveDone,
      };
      this.pending.set(state, pending);

      http.on("request", (req, res) => {
        const got = new URL(req.url ?? "/", redirectUri);
        if (got.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end("not found");
          return;
        }
        const error = got.searchParams.get("error");
        const code = got.searchParams.get("code");
        const gotState = got.searchParams.get("state");
        if (error) {
          this.fail(state, `授权被拒绝：${error}`);
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end("<h1>授权失败</h1><p>可以关闭此窗口。</p>");
          return;
        }
        if (!gotState || gotState !== state) {
          /* state 不匹配 = 可能被 CSRF/串了流程：不做任何交换 */
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end("<h1>state 不匹配</h1>");
          return;
        }
        if (!code) {
          this.fail(state, "回调里没有授权码");
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end("<h1>缺少授权码</h1>");
          return;
        }
        void this.finish(state, code).then((result) => {
          const ok = result.ok;
          res
            .writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" })
            .end(
              ok
                ? "<h1>授权完成</h1><p>可以关闭此窗口，回到 Ding Harness。</p>"
                : `<h1>授权失败</h1><p>${escapeHtml(result.error)}</p>`,
            );
        });
      });

      return { ok: true, url: url.toString(), state };
    } catch (error) {
      return { ok: false, error: humanError(error) };
    }
  }

  /** 等回环回调（或手动完成）。超时会取消这条 pending。 */
  async wait(state: string): Promise<AuthorizeResult> {
    const pending = this.pending.get(state);
    if (!pending) return { ok: false, error: "没有这个授权流程（可能已超时或已完成）" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMessage = `授权超时（${Math.round(this.timeoutMs / 60_000)} 分钟）`;
    const timeout = new Promise<AuthorizeResult>((resolve) => {
      timer = setTimeout(() => {
        /* 用同一条文案收掉 pending：race 里先醒的是哪一边都得到"超时"。 */
        this.cancel(state, timeoutMessage);
        resolve({ ok: false, error: timeoutMessage });
      }, this.timeoutMs);
    });
    const result = await Promise.race([pending.done, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  /** 手动回退：用户把授权码粘回来（浏览器没被打开/回调打不通时）。 */
  async complete(state: string, code: string): Promise<AuthorizeResult> {
    if (!code.trim()) return { ok: false, error: "授权码是空的" };
    return await this.finish(state, code.trim());
  }

  cancel(state: string, reason = "授权已取消"): void {
    const pending = this.pending.get(state);
    if (!pending) return;
    pending.settled = true;
    try {
      pending.server.close();
    } catch {
      /* 已关 */
    }
    this.pending.delete(state);
    pending.resolve({ ok: false, error: reason });
  }

  /** 刷新 token（401 时由传输层调）。失败返回 null，但**不清空已有授权**。 */
  async refreshToken(serverName: string, token = this.cached(serverName)): Promise<StoredOAuth | null> {
    if (!token?.refreshToken) return null;
    try {
      const res = await this.fetchImpl(token.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: token.refreshToken,
          client_id: token.clientId,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, unknown>;
      const next = this.fromTokenResponse(body, token, token.refreshToken);
      this.store(serverName, next);
      return next;
    } catch {
      return null;
    }
  }

  /** 测试/诊断用：当前挂起的流程数。 */
  pendingCount(): number {
    return this.pending.size;
  }

  private cached(serverName: string): StoredOAuth | null {
    const hit = this.cache.get(serverName);
    if (hit) return hit;
    const saved = this.deps.tokenStore.load(serverName);
    if (saved) this.cache.set(serverName, saved);
    return saved ?? null;
  }

  private store(serverName: string, token: StoredOAuth): { ok: true } | { ok: false; error: string } {
    this.cache.set(serverName, token);
    return this.deps.tokenStore.save(serverName, token);
  }

  private async finish(state: string, code: string): Promise<AuthorizeResult> {
    const pending = this.pending.get(state);
    if (!pending) return { ok: false, error: "没有这个授权流程（可能已超时或已完成）" };
    if (pending.settled) return { ok: false, error: "这条授权流程已经结束" };
    pending.settled = true;
    try {
      const res = await this.fetchImpl(pending.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: pending.redirectUri,
          client_id: pending.clientId,
          code_verifier: pending.verifier,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const result: AuthorizeResult = {
          ok: false,
          error: `token 交换失败（HTTP ${res.status}${typeof body.error === "string" ? `：${body.error}` : ""}）`,
        };
        pending.resolve(result);
        this.close(state);
        return result;
      }
      const base: StoredOAuth = {
        accessToken: "",
        tokenEndpoint: pending.tokenEndpoint,
        clientId: pending.clientId,
        serverUrl: pending.serverUrl,
        ...(pending.scope ? { scope: pending.scope } : {}),
      };
      const token = this.fromTokenResponse(body, base);
      if (!token.accessToken) {
        const result: AuthorizeResult = { ok: false, error: "token 回包里没有 access_token" };
        pending.resolve(result);
        this.close(state);
        return result;
      }
      const saved = this.store(pending.serverName, token);
      const result: AuthorizeResult = saved.ok
        ? { ok: true, token, persisted: true }
        : { ok: true, token, persisted: false, persistError: saved.error };
      pending.resolve(result);
      this.close(state);
      return result;
    } catch (error) {
      const result: AuthorizeResult = { ok: false, error: `token 交换失败：${humanError(error)}` };
      pending.resolve(result);
      this.close(state);
      return result;
    }
  }

  private fromTokenResponse(body: Record<string, unknown>, base: StoredOAuth, fallbackRefresh?: string): StoredOAuth {
    const accessToken = typeof body.access_token === "string" ? body.access_token : "";
    const refreshToken =
      typeof body.refresh_token === "string" ? body.refresh_token : fallbackRefresh ?? base.refreshToken;
    const expiresIn = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : undefined;
    const scope = typeof body.scope === "string" ? body.scope : base.scope;
    return {
      ...base,
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresIn !== undefined ? { expiresAt: this.now() + Math.max(0, expiresIn) * 1000 } : {}),
      ...(scope ? { scope } : {}),
    };
  }

  private close(state: string): void {
    const pending = this.pending.get(state);
    if (!pending) return;
    try {
      pending.server.close();
    } catch {
      /* 已关 */
    }
    this.pending.delete(state);
  }

  private fail(state: string, error: string): void {
    const pending = this.pending.get(state);
    if (!pending) return;
    pending.settled = true;
    pending.resolve({ ok: false, error });
    this.close(state);
  }

  private listen(): Promise<{ server: Server; port: number }> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("回环端口没有分配出来"));
          return;
        }
        resolve({ server, port: address.port });
      });
    });
  }

  /**
   * 发现授权服务器（RFC 8414 / MCP 的 protected resource metadata）。
   *
   * 顺序：`resource_metadata` → 端点同源的 well-known → 直接把 MCP 端点当 issuer
   * （最后一条是给"元数据不标准但实现了 OAuth"的 server 留的窄退路）。
   */
  async discover(serverUrl: string, resourceMetadata?: string): Promise<AuthServerMetadata> {
    const origin = new URL(serverUrl).origin;
    const candidates: string[] = [];
    if (resourceMetadata) candidates.push(resourceMetadata);
    const path = new URL(serverUrl).pathname.replace(/\/+$/, "");
    candidates.push(`${origin}/.well-known/oauth-protected-resource${path}`);
    candidates.push(`${origin}/.well-known/oauth-protected-resource`);

    let issuer = "";
    for (const candidate of candidates) {
      const meta = await this.getJson(candidate);
      if (!meta) continue;
      const servers = Array.isArray(meta.authorization_servers)
        ? meta.authorization_servers.filter((x): x is string => typeof x === "string")
        : [];
      if (servers.length) issuer = servers[0]!;
      if (issuer) break;
    }
    if (!issuer) issuer = origin;

    const issuerBase = issuer.replace(/\/+$/, "");
    const asCandidates = [
      `${issuerBase}/.well-known/oauth-authorization-server`,
      `${issuerBase}/.well-known/openid-configuration`,
      `${issuerBase}/.well-known/oauth-authorization-server${new URL(serverUrl).pathname}`,
    ];
    for (const candidate of asCandidates) {
      const meta = await this.getJson(candidate);
      if (!meta) continue;
      const authorizationEndpoint = typeof meta.authorization_endpoint === "string" ? meta.authorization_endpoint : "";
      const tokenEndpoint = typeof meta.token_endpoint === "string" ? meta.token_endpoint : "";
      if (!authorizationEndpoint || !tokenEndpoint) continue;
      return {
        ...(typeof meta.issuer === "string" ? { issuer: meta.issuer } : {}),
        authorizationEndpoint,
        tokenEndpoint,
        ...(typeof meta.registration_endpoint === "string" ? { registrationEndpoint: meta.registration_endpoint } : {}),
        ...(Array.isArray(meta.scopes_supported)
          ? {
              scopesSupported: meta.scopes_supported.filter((x): x is string => typeof x === "string"),
            }
          : {}),
      };
    }
    throw new Error("找不到授权服务器元数据（服务器可能没实现 OAuth，或只支持自定义鉴权头）");
  }

  private async getJson(url: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private async registerClient(metadata: AuthServerMetadata, redirectUri: string): Promise<string | null> {
    if (!metadata.registrationEndpoint) return null;
    try {
      const res = await this.fetchImpl(metadata.registrationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_name: "Ding Harness",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { client_id?: unknown };
      return typeof body.client_id === "string" ? body.client_id : null;
    } catch {
      return null;
    }
  }
}

function humanError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
