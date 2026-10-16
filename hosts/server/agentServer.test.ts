import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { CwdNotAllowedError } from "../cwd";
import { startAgentServer, type ServerOptions } from "./agentServer";
import { createSyncRelay } from "../../engine/sync/relay";

/**
 * Agent Server（Phase 17；2026-10-16 按审计第 1 单收紧）。
 *
 * ## 这里验的是什么
 *
 * 1. **fail-closed 鉴权**：不给 token 也会生成一个 —— 不带凭据一律 401
 *    （`/healthz` 除外）；错 token 会触发限速（连续 8 次锁 30 秒）。
 * 2. **Host / Origin / Sec-Fetch 白名单**：`Host` 非白名单 400、跨站或陌生
 *    `Origin` 403 —— 挡 drive-by / DNS rebinding（token 之外的第二道门）。
 * 3. **cwd 授权拒绝是 400**（不是静默落回默认目录、更不是 500）。
 * 4. **连上就断线 → 真中止**（不给孤儿回合留下继续烧钱的机会）；
 *    `stop()` 会中止在跑回合并把在途连接收掉。
 * 5. **webhook 一律验签**（缺签名 403；没配密钥整体 403）；`constructor`
 *    这种原型属性名字穿过不了"只跑配过的 names"那道门。
 * 6. **访问日志**每一条请求一行（含被拒的）。
 * 7. **请求体按字节收再解码**：中文跨 chunk 不碎。
 *
 * ## 不起真模型
 *
 * `makeEngine` 是注入的假对象：跑一轮立即返回（或者挂起直到 abort）。
 * 于是这一组测的是**协议与安全口径**，毫秒级、不需要任何 key。
 */

type FakeBehaviour = {
  /** 跑一轮挂起，直到 abortSignal 触发（用来测取消通道与关闭路径）。 */
  hang?: boolean;
  /** 这些 cwd 一律拒绝（模拟真实宿主里的 `CwdNotAllowedError`）。 */
  rejectCwd?: string[];
};

function fakeEngineFactory(behaviour: FakeBehaviour = {}) {
  const opened: string[] = [];
  const messages: string[] = [];
  const sessionIds: (string | undefined)[] = [];
  let aborted = 0;
  return {
    opened,
    messages,
    sessionIds,
    get aborted() {
      return aborted;
    },
    makeEngine: async (cwd: string) => {
      if (behaviour.rejectCwd?.includes(cwd)) throw new CwdNotAllowedError(`工作目录不在授权范围内：${cwd}`);
      opened.push(cwd);
      return {
        engine: {
          async run(request: { messages: { content: string }[]; sessionId?: string; onEvent?: (e: unknown) => void; abortSignal?: AbortSignal }) {
            messages.push(request.messages[0]!.content);
            sessionIds.push(request.sessionId);
            if (behaviour.hang) {
              return await new Promise((resolve) => {
                const done = () => {
                  aborted += 1;
                  resolve({ ok: false, aborted: true, events: [], records: [], requestId: "r1", provider: "fake", model: "fake" });
                };
                if (request.abortSignal?.aborted) done();
                else request.abortSignal?.addEventListener("abort", done, { once: true });
              });
            }
            request.onEvent?.({ type: "text", text: "你好" });
            return { ok: true, aborted: false, events: [], records: [], requestId: "r1", provider: "fake", model: "fake" };
          },
          async resume() {
            return { turns: [], pending: [] };
          },
          tools: {},
        },
        close: () => undefined,
      };
    },
  } as never as {
    opened: string[];
    messages: string[];
    sessionIds: (string | undefined)[];
    readonly aborted: number;
    makeEngine: (cwd: string) => Promise<{ engine: never; close: () => void }>;
  };
}

/**
 * 起过的服务统一在结算时 `stop()`。
 *
 * keep-alive 连接（`node:http` 的全局 agent 默认开着）会拖住普通的
 * `server.close()` —— 它要等所有连接结束，而连接要等客户端；测试进程
 * 因此会挂住。`stop()` 会销毁在途连接，也正是产品里那条关闭路径，
 * 顺带每次都被这批测试走到。
 */
const running: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of running.splice(0)) await stop();
});

/** 起一个服务并拿它的地址（端口给 0 = 系统分配）。 */
async function boot(over: Partial<ServerOptions> = {}, behaviour: FakeBehaviour = {}) {
  const fake = fakeEngineFactory(behaviour);
  const logs: string[] = [];
  const started = await startAgentServer({
    port: 0,
    makeEngine: fake.makeEngine as never,
    mode: "按需确认",
    provider: "fake",
    cwd: process.cwd(),
    log: (line) => logs.push(line),
    ...over,
  });
  running.push(started.stop);
  return { ...started, fake, logs };
}

/**
 * 发一条请求。
 *
 * 用 `node:http` 而不是 `fetch`：这几条断言要的就是"能自己控制 Host / Origin /
 * Sec-Fetch 这类头"，而 fetch 对这些头有它自己的想法。
 */
function call(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: init.headers ?? {} },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 对一段原始字节算 webhook 签名（与被测实现同一套：HMAC-SHA256 的十六进制）。 */
const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")}`;

describe("Agent Server（Phase 17 · 第 1 单收紧）", () => {
  it("① 默认只绑回环（不给 bind 时是本机地址）", async () => {
    const { url } = await boot();
    expect(url).toContain("127.0.0.1");
  });

  it("⭐ ② 对外绑定**没给 token 就起不来**（硬拒，不是警告）", async () => {
    await expect(boot({ bind: "0.0.0.0" })).rejects.toThrow(/token/);
  });

  it("③ 对外绑定给了 token 就能起来", async () => {
    const { server } = await boot({ bind: "0.0.0.0", token: "s3cret" });
    server.close();
  });

  it("④ /healthz 不要 token（探活）；其它接口一律要", async () => {
    const { server, port, token } = await boot({ token: "s3cret" });
    try {
      const health = await call(port, "/healthz");
      expect(health.status).toBe(200);

      const noToken = await call(port, "/v1/info");
      expect(noToken.status).toBe(401);

      const wrong = await call(port, "/v1/info", { headers: bearer("nope") });
      expect(wrong.status).toBe(401);

      const ok = await call(port, "/v1/info", { headers: bearer("s3cret") });
      expect(ok.status).toBe(200);
      const info = JSON.parse(ok.text) as { name: string; mode: string; hooks: string[] };
      expect(info.name).toBe("ding-harness");
      /* 外部宿主该知道"写与执行会不会被拦" */
      expect(info.mode).toBe("按需确认");
      expect(Array.isArray(info.hooks)).toBe(true);
      expect(token).toBe("s3cret");
    } finally {
      server.close();
    }
  });

  it("⭐⭐ ⑤ fail-closed：回环 + 不给 token 也会生成一个，不带凭据就是 401", async () => {
    /* 这条是审计 P166 的正面：默认形态**不再**是零鉴权 */
    const { server, port, token } = await boot();
    try {
      expect(token.length).toBeGreaterThan(16);
      const anon = await call(port, "/v1/info");
      expect(anon.status).toBe(401);

      const ok = await call(port, "/v1/info", { headers: bearer(token) });
      expect(ok.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("⭐ ⑥ 错 token 连错 8 次锁定 30 秒（暴力猜口令的代价）", async () => {
    const { server, port, token } = await boot({ token: "s3cret" });
    try {
      for (let i = 0; i < 8; i += 1) {
        const res = await call(port, "/v1/info", { headers: bearer(`guess-${i}`) });
        expect(res.status).toBe(401);
      }
      /* 锁定期内：错的 429，**对的也 429**（锁定是真的） */
      const locked = await call(port, "/v1/info", { headers: bearer("guess-x") });
      expect(locked.status).toBe(429);
      const evenRight = await call(port, "/v1/info", { headers: bearer(token) });
      expect(evenRight.status).toBe(429);
    } finally {
      server.close();
    }
  });

  it("⭐ ⑦ Host / Origin / Sec-Fetch：非白名单一律拒（挡 drive-by 与 DNS rebinding）", async () => {
    const { server, port, token } = await boot({ token: "s3cret" });
    try {
      /* Host 不是本机名字 → 400（DNS rebinding 那个名字进不来） */
      const badHost = await call(port, "/v1/info", { headers: { ...bearer(token), host: "evil.example.com" } });
      expect(badHost.status).toBe(400);

      /* 陌生 Origin → 403（浏览器被别人指挥着打本机 agent） */
      const badOrigin = await call(port, "/v1/info", { headers: { ...bearer(token), origin: "https://evil.example.com" } });
      expect(badOrigin.status).toBe(403);

      /* 跨站发起 → 403 */
      const crossSite = await call(port, "/v1/info", { headers: { ...bearer(token), "sec-fetch-site": "cross-site" } });
      expect(crossSite.status).toBe(403);

      /* 本机 Origin 放行 */
      const localOrigin = await call(port, "/v1/info", { headers: { ...bearer(token), origin: `http://127.0.0.1:${port}` } });
      expect(localOrigin.status).toBe(200);

      /* 探活也不放行陌生 Host（"拒"就是拒，没有例外面） */
      const healthBadHost = await call(port, "/healthz", { headers: { host: "evil.example.com" } });
      expect(healthBadHost.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it("⭐ ⑧ 绝对形式的请求目标（越界端口）→ 400，而不是把进程带走", async () => {
    /*
     * 审计 P169/P170：`new URL("http://a:99999/")` 抛 TypeError，
     * 而那一句原来在鉴权外、try 外 —— 一个**未鉴权**的请求就能打倒服务。
     */
    const { server, port } = await boot({ token: "s3cret" });
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.write("GET http://a:99999/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        });
        let data = "";
        socket.on("data", (chunk) => (data += chunk.toString("utf8")));
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
      });
      expect(raw).toContain("400");

      /* 服务还活着 */
      const after = await call(port, "/healthz");
      expect(after.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("⑨ POST /v1/run 是 SSE：事件按 `event: …` 推出来，最后一条 done（带生效 cwd）", async () => {
    const { server, port, token } = await boot({ token: "s3cret" });
    try {
      const res = await call(port, "/v1/run", {
        method: "POST",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: JSON.stringify({ message: "你好" }),
      });
      expect(res.status).toBe(200);
      expect(res.text).toContain("event: event");
      expect(res.text).toContain('"type":"text"');
      expect(res.text).toContain("event: done");
      /* P181：生效的 cwd 要回显（客户端才知道自己指定的目录有没有被换） */
      expect(res.text).toContain(JSON.stringify(process.cwd()).slice(1, -1));
    } finally {
      server.close();
    }
  });

  it("⑩ /v1/run 没有 message 就 400（不是跑一轮空提示）；坏 JSON 也是 400", async () => {
    const { server, port, token } = await boot({ token: "s3cret" });
    try {
      const empty = await call(port, "/v1/run", {
        method: "POST",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(empty.status).toBe(400);

      const badJson = await call(port, "/v1/run", {
        method: "POST",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: "{不是 json",
      });
      expect(badJson.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it("⭐ ⑪ cwd 不在授权范围 → 400（明确拒绝，不静默落回默认目录）", async () => {
    const outside = process.cwd() + "-evil";
    const { server, port, token } = await boot({ token: "s3cret" }, { rejectCwd: [outside] });
    try {
      const res = await call(port, "/v1/run", {
        method: "POST",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: JSON.stringify({ message: "你好", cwd: outside }),
      });
      expect(res.status).toBe(400);
      expect(res.text).toContain("授权范围");
    } finally {
      server.close();
    }
  });

  it("⭐ ⑫ webhook：缺签名 / 错签名 403，对签名 200；没配密钥整体 403", async () => {
    const body = JSON.stringify({ hello: "world" });
    const withSecret = await boot({ token: "s3cret", hooks: { nightly: "汇总今天的对话" }, hooksSecret: "hooksecret" });
    try {
      const noSig = await call(withSecret.port, "/v1/hooks/nightly", {
        method: "POST",
        headers: { ...bearer("s3cret"), "content-type": "application/json" },
        body,
      });
      expect(noSig.status).toBe(403);

      const badSig = await call(withSecret.port, "/v1/hooks/nightly", {
        method: "POST",
        headers: { ...bearer("s3cret"), "x-hub-signature-256": "sha256=" + "0".repeat(64) },
        body,
      });
      expect(badSig.status).toBe(403);

      const good = await call(withSecret.port, "/v1/hooks/nightly", {
        method: "POST",
        headers: { ...bearer("s3cret"), "x-hub-signature-256": sign("hooksecret", body) },
        body,
      });
      expect(good.status).toBe(200);
      expect(good.text).toContain("event: done");

      /* 配过的名字之外仍然 404（说清有哪些） */
      const unknown = await call(withSecret.port, "/v1/hooks/nope", {
        method: "POST",
        headers: { ...bearer("s3cret"), "x-hub-signature-256": sign("hooksecret", body) },
        body,
      });
      expect(unknown.status).toBe(404);
      expect(unknown.text).toContain("nightly");
    } finally {
      withSecret.server.close();
    }

    /* 没配密钥：webhook 一律 403（缺省 fail-closed） */
    const noSecret = await boot({ token: "s3cret", hooks: { nightly: "汇总今天的对话" } });
    try {
      const res = await call(noSecret.port, "/v1/hooks/nightly", {
        method: "POST",
        headers: { ...bearer("s3cret"), "x-hub-signature-256": "sha256=" + "0".repeat(64) },
        body,
      });
      expect(res.status).toBe(403);
    } finally {
      noSecret.server.close();
    }
  });

  it("⭐ ⑬ webhook 名字走原型属性也进不来（constructor / toString → 404）", async () => {
    const { server, port, token } = await boot({ token: "s3cret", hooks: {}, hooksSecret: "s" });
    try {
      for (const name of ["constructor", "toString", "__proto__"]) {
        const res = await call(port, `/v1/hooks/${name}`, {
          method: "POST",
          headers: { ...bearer(token), "x-hub-signature-256": sign("s", "") },
          body: "",
        });
        expect(res.status, `原型属性名 ${name} 竟然穿过了钩子名单`).toBe(404);
      }
    } finally {
      server.close();
    }
  });

  it("⑭ 不认识的路径 404（而不是静默成功）", async () => {
    const { server, port, token } = await boot({ token: "s3cret" });
    try {
      const res = await call(port, "/v1/nope", { headers: bearer(token) });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("⑮ 请求体有上限（别让一个超大 body 把内存吃光）", async () => {
    const { server, port, token } = await boot({ token: "s3cret" });
    try {
      /*
       * 超限时服务端**直接把连接掐掉**（比"读完再报错"更省内存）——
       * 所以这里要接受两种拒绝形态：一个错误状态码，或者连接被 reset。
       * 判据是"**没有跑成功**"，不是"回了哪个码"。
       */
      let rejected = false;
      try {
        const res = await call(port, "/v1/run", {
          method: "POST",
          headers: { ...bearer(token), "content-type": "application/json" },
          body: JSON.stringify({ message: "x".repeat(1_100_000) }),
        });
        rejected = res.status >= 400;
      } catch {
        rejected = true; // ECONNRESET / EPIPE：连接被掐了，也算拒绝
      }
      expect(rejected, "超大请求体竟然跑通了").toBe(true);
    } finally {
      server.close();
    }
  });

  it("⭐ ⑯ 请求体按字节收：中文正好跨 chunk 也不碎（不是 U+FFFD）", async () => {
    /*
     * 审计 P179：逐块 `toString("utf8")` 会把落在 chunk 边界上的汉字劈成两个 U+FFFD。
     * 这里手工分帧（在第一个汉字中间切开 + 中间停一下），把这个形状**确定性地**造出来。
     */
    const { server, port, token, fake } = await boot({ token: "s3cret" });
    const message = "汉".repeat(200);
    try {
      const body = Buffer.from(JSON.stringify({ message }), "utf8");
      const cut = body.indexOf(Buffer.from("汉", "utf8")) + 1; // 切在一个汉字的字节中间
      const head =
        `POST /v1/run HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
      const raw = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.write(head);
          socket.write(body.subarray(0, cut));
          setTimeout(() => socket.write(body.subarray(cut)), 40); // 两半分两次到
        });
        let data = "";
        socket.setTimeout(3000, () => {
          socket.destroy();
          resolve(data);
        });
        socket.on("data", (chunk) => {
          data += chunk.toString("utf8");
          if (data.includes("event: done")) {
            /* SSE 是 keep-alive 的：看到终止事件就收，不等对端关连接 */
            socket.destroy();
            resolve(data);
          }
        });
        socket.on("close", () => resolve(data));
        socket.on("error", reject);
      });
      expect(raw).toContain("200");
      /* 服务端收到的正文与发出去的一模一样（长度与内容都要对） */
      expect(fake.messages).toEqual([message]);
    } finally {
      server.close();
    }
  });

  it("⭐ ⑰ 客户端断开 → 这一轮被中止（不留孤儿回合）", async () => {
    const { server, port, token, fake } = await boot({ token: "s3cret" }, { hang: true });
    try {
      const controller = new AbortController();
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/v1/run", method: "POST", headers: { ...bearer(token), "content-type": "application/json" } },
        () => undefined,
      );
      req.on("error", () => undefined); // 掐断时必然报错，忽略
      req.write(JSON.stringify({ message: "挂起的一轮" }));
      req.end();
      await sleep(60); // 让引擎跑起来（挂在 abortSignal 上）
      controller.abort();
      req.destroy(); // 客户端走人

      let waited = 0;
      while (fake.aborted === 0 && waited < 2000) {
        await sleep(25);
        waited += 25;
      }
      expect(fake.aborted, "客户端都走了，这一轮还在跑").toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  it("⭐ ⑱ stop()：中止在跑回合 + 收掉在途连接（关闭不拖泥带水）", async () => {
    const { port, token, fake, stop } = await boot({ token: "s3cret" }, { hang: true });
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/v1/run", method: "POST", headers: { ...bearer(token), "content-type": "application/json" } },
      () => undefined,
    );
    req.on("error", () => undefined);
    req.write(JSON.stringify({ message: "挂起的一轮" }));
    req.end();
    await sleep(60);
    await stop();
    expect(fake.aborted, "关闭时在跑的回合没有被中止").toBeGreaterThan(0);
  });

  it("⭐ ⑲ /v1/sessions：没接会话库回 501（不假装空列表）；接了就是真列表", async () => {
    const bare = await boot({ token: "s3cret" });
    try {
      const res = await call(bare.port, "/v1/sessions", { headers: bearer("s3cret") });
      expect(res.status).toBe(501);
    } finally {
      bare.server.close();
    }

    const wired = await boot({
      token: "s3cret",
      listSessions: async () => [
        { sessionId: "chat-a", conversationId: "a", title: "甲", updatedAt: 1, bytes: 10 },
      ],
    });
    try {
      const res = await call(wired.port, "/v1/sessions", { headers: bearer("s3cret") });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text).sessions).toHaveLength(1);
    } finally {
      wired.server.close();
    }
  });

  it("⭐ ⑳ 访问日志：每一条请求都有一行（含被拒的）", async () => {
    const { server, port, logs, token } = await boot({ token: "s3cret" });
    try {
      await call(port, "/healthz");
      await call(port, "/v1/info"); // 401
      await call(port, "/v1/info", { headers: bearer(token) }); // 200
      await sleep(30);
      const joined = logs.join("\n");
      expect(joined).toContain("GET /healthz → 200");
      expect(joined).toContain("GET /v1/info → 401");
      expect(joined).toContain("GET /v1/info → 200");
    } finally {
      server.close();
    }
  });
});

/** 顺带钉一下"端口 0 = 系统分配"这条约定（验收脚本靠它避开冲突端口）。 */
describe("端口约定", () => {
  it("port 0 → 回一个真的可用端口", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    expect(port).toBeGreaterThan(0);
    server.close();
  });
});

/**
 * 同步中继的 HTTP 端点（V5-2 任务 2.1 的服务端那一半）。
 *
 * 这里**不重测协议语义**（那个在 `engine/sync/relay.test.ts` 里逐条钉着）——
 * 这里验的是"语义原样过网"：接线没给就 501、四个动作用法与状态码、
 * 以及**协议层的拒绝走 409**（请求本身没毛病，是状态不允许）。
 */
describe("同步中继端点（/v1/streams/*）", () => {
  it("⭐ 中继没接线：回 501，不假装一条空流", async () => {
    const { port, token } = await boot();
    const res = await call(port, "/v1/streams/s-1", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(501);
    expect(res.text).toContain("没有接同步中继");
  });

  it("⭐ 一条流走完四步：建流 → 接管 → 推 → 拉（语义原样过网）", async () => {
    const relay = createSyncRelay({ now: () => 1_700_000_000_000 });
    const { port, token } = await boot({ relay });
    const auth = { Authorization: `Bearer ${token}`, "content-type": "application/json" };

    const created = await call(port, "/v1/streams/s-1", { method: "PUT", headers: auth });
    expect(created.status).toBe(200);

    const claimed = await call(port, "/v1/streams/s-1/claim", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ holder: "手机" }),
    });
    expect(claimed.status).toBe(200);
    const epoch = (JSON.parse(claimed.text) as { epoch: number }).epoch;

    const pushed = await call(port, "/v1/streams/s-1/push", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        producerId: "p-1",
        epoch,
        events: [
          { id: "e-1", seq: 1, type: "text", payload: { type: "text", text: "甲" } },
          { id: "e-2", seq: 2, type: "text", payload: { type: "text", text: "乙" } },
        ],
      }),
    });
    expect(pushed.status).toBe(200);
    expect(JSON.parse(pushed.text)).toMatchObject({ ok: true, accepted: 2, nextOffset: 3 });

    const pulled = await call(port, "/v1/streams/s-1/pull?from=0&limit=10", { headers: auth });
    expect(pulled.status).toBe(200);
    const page = JSON.parse(pulled.text) as { events: Array<{ offset: number; id?: string }>; nextOffset: number; hasMore: boolean };
    expect(page.events.map((e) => [e.offset, e.id])).toEqual([[1, "e-1"], [2, "e-2"]]);
    expect(page).toMatchObject({ nextOffset: 2, hasMore: false });

    const state = await call(port, "/v1/streams/s-1", { headers: auth });
    expect(state.status).toBe(200);
    expect(JSON.parse(state.text).state).toMatchObject({ epoch, holder: "手机", nextOffset: 3 });
  });

  it("⭐ 协议层的拒绝走 409（fenced / gap 都算状态不允许，请求本身没毛病）", async () => {
    const relay = createSyncRelay();
    const { port, token } = await boot({ relay });
    const auth = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
    await call(port, "/v1/streams/s-2", { method: "PUT", headers: auth });
    const claimed = await call(port, "/v1/streams/s-2/claim", { method: "POST", headers: auth, body: "{}" });
    const epoch = (JSON.parse(claimed.text) as { epoch: number }).epoch;
    await call(port, "/v1/streams/s-2/claim", { method: "POST", headers: auth, body: "{}" }); // 另一端接管

    const stale = await call(port, "/v1/streams/s-2/push", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ producerId: "p", epoch, events: [{ seq: 1, type: "text", payload: {} }] }),
    });
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.text)).toMatchObject({ ok: false, code: "fenced" });

    const gap = await call(port, "/v1/streams/s-2/push", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ producerId: "p", epoch: epoch + 1, events: [{ seq: 5, type: "text", payload: {} }] }),
    });
    expect(gap.status).toBe(409);
    expect(JSON.parse(gap.text)).toMatchObject({ ok: false, code: "gap", expected: 1 });
  });

  it("参数不对 / 流不存在 / 方法不对：400 / 404 / 405 各归各的", async () => {
    const relay = createSyncRelay();
    const { port, token } = await boot({ relay });
    const auth = { Authorization: `Bearer ${token}`, "content-type": "application/json" };

    /* 路径要 percent 编码（http 客户端不让裸中文上路）—— 服务端那边解码后再判形状 */
    const badId = await call(port, `/v1/streams/${encodeURIComponent("带 空格")}`, { method: "PUT", headers: auth });
    expect(badId.status).toBe(400);

    const noStream = await call(port, `/v1/streams/${encodeURIComponent("没这条")}`, { headers: auth });
    expect(noStream.status).toBe(404);

    await call(port, "/v1/streams/s-3", { method: "PUT", headers: auth });
    const badBody = await call(port, "/v1/streams/s-3/push", { method: "POST", headers: auth, body: "{不是 json" });
    expect(badBody.status).toBe(400);

    const wrongMethod = await call(port, "/v1/streams/s-3/push", { headers: auth });
    expect(wrongMethod.status).toBe(405);
  });

  it("鉴权照旧：没带 token 的 streams 请求同样是 401（新端点不是后门）", async () => {
    const relay = createSyncRelay();
    const { port } = await boot({ relay });
    const res = await call(port, "/v1/streams/s-1", { method: "PUT" });
    expect(res.status).toBe(401);
  });
});

/**
 * 坏百分号编码：**400，不是 500**（V5-2 2.1 实测逮到的那条）。
 *
 * 起因：本机 curl 把中文 id 按代码页（GBK）编码成 `%CA%D6`，`decodeURIComponent`
 * 抛 URIError —— 服务端答了"500 内部错误"。请求本身不对就是 400；
 * 同一形状在 sessions / hooks / streams 三条路上都收进了 `safeDecode`。
 */
describe("路径里的坏百分号编码（三条路都要 400）", () => {
  it("⭐ streams / sessions / hooks：解不开的路径段一律 400（不冒充 500）", async () => {
    const relay = createSyncRelay();
    const { port, token } = await boot({ relay, hooks: { demo: "跑一下" }, hooksSecret: "s3cret" });
    const auth = { Authorization: `Bearer ${token}` };

    /* 三条路各自的方法：streams 建流 PUT / sessions 读 GET / hooks 触发 POST */
    const cases: Array<[string, string]> = [
      ["/v1/streams/%CA%D6-A", "PUT"],
      ["/v1/sessions/%CA%D6", "GET"],
      ["/v1/hooks/%CA%D6", "POST"],
    ];
    for (const [path, method] of cases) {
      const res = await call(port, path, { method, headers: auth });
      expect(res.status, `${method} ${path} 答了 ${res.status}`).toBe(400);
      expect(res.text).toContain("不合法");
    }
  });
});

/**
 * 成员 token 与归属过滤（V5-2 任务 2.2）。
 *
 * 三条要挡的事：
 *   ① **认证机制不变、身份细化**：主口令仍是"本机主人"（全权），
 *      成员口令认得出是谁（`/v1/info` 的 `you`）——而 401 / 限速那条路一个字不改；
 *   ② **成员只看得到归自己的**：不给参数也只列自己的；指别人的 owner → **403**
 *      （不是"悄悄过滤成空"—— 那会让人以为对方没有会话）；
 *   ③ 坏配置**启动就拒**（重复 id / 空口令 / 口语与主口令相同）。
 */
describe("成员 token 与 owner 过滤（V5-2 2.2）", () => {
  const members = [
    { id: "alice", token: "sk-alice-123" },
    { id: "bob", token: "sk-bob-456" },
  ];
  const sessions = [
    { sessionId: "s-1", conversationId: "s-1", title: "alice 的", updatedAt: 3, bytes: 1, owner: "alice" },
    { sessionId: "s-2", conversationId: "s-2", title: "bob 的", updatedAt: 2, bytes: 1, owner: "bob" },
    { sessionId: "s-3", conversationId: "s-3", title: "本机主人的", updatedAt: 1, bytes: 1, owner: "local" },
  ];
  const boot2 = (over: Partial<ServerOptions> = {}) => boot({ members, listSessions: async () => sessions, ...over });

  it("⭐ 成员口令认得出身份（/v1/info 的 you）；主口令 = 本机主人", async () => {
    const { port, token } = await boot2();
    const asAlice = await call(port, "/v1/info", { headers: { Authorization: "Bearer sk-alice-123" } });
    expect(asAlice.status).toBe(200);
    expect(JSON.parse(asAlice.text).you).toEqual({ id: "alice", owner: false });

    const asOwner = await call(port, "/v1/info", { headers: { Authorization: `Bearer ${token}` } });
    expect(JSON.parse(asOwner.text).you).toEqual({ id: "local", owner: true });
  });

  it("⭐ 成员只列归自己的（不给参数也一样）；指别人的 owner → 403", async () => {
    const { port } = await boot2();
    const aliceAuth = { Authorization: "Bearer sk-alice-123" };

    const implicit = await call(port, "/v1/sessions", { headers: aliceAuth });
    expect(implicit.status).toBe(200);
    const listed = JSON.parse(implicit.text) as { sessions: Array<{ sessionId: string }> };
    expect(listed.sessions.map((s) => s.sessionId), "成员看到了别人的会话").toEqual(["s-1"]);

    /* 显式要自己的：照给 */
    const own = await call(port, "/v1/sessions?owner=alice", { headers: aliceAuth });
    expect(own.status).toBe(200);

    /* 要别人的：403（不是空列表） */
    const theirs = await call(port, "/v1/sessions?owner=bob", { headers: aliceAuth });
    expect(theirs.status).toBe(403);
    expect(theirs.text).toContain("只能查归你的会话");
  });

  it("本机主人：不给参数列全部；给 `?owner=` 就过滤（老口径照旧）", async () => {
    const { port, token } = await boot2();
    const auth = { Authorization: `Bearer ${token}` };
    const all = JSON.parse((await call(port, "/v1/sessions", { headers: auth })).text) as { sessions: unknown[] };
    expect(all.sessions).toHaveLength(3);
    const filtered = JSON.parse((await call(port, "/v1/sessions?owner=bob", { headers: auth })).text) as {
      sessions: Array<{ sessionId: string }>;
    };
    expect(filtered.sessions.map((s) => s.sessionId)).toEqual(["s-2"]);
  });

  it("旧会话（没有 owner 那一格）按兼容口径 local 读：成员看不到，主人看得到", async () => {
    const legacy = [{ sessionId: "s-old", conversationId: "s-old", title: "老会话", updatedAt: 1, bytes: 1 }];
    const { port, token } = await boot({ members, listSessions: async () => legacy });
    const asAlice = JSON.parse((await call(port, "/v1/sessions", { headers: { Authorization: "Bearer sk-alice-123" } })).text) as {
      sessions: unknown[];
    };
    expect(asAlice.sessions, "alice 看到了本机主人的旧会话").toHaveLength(0);
    const asOwner = JSON.parse((await call(port, "/v1/sessions", { headers: { Authorization: `Bearer ${token}` } })).text) as {
      sessions: unknown[];
    };
    expect(asOwner.sessions).toHaveLength(1);
  });

  it("坏口令照旧 401（新身份层不是后门）；主口令与成员口令并存互不干扰", async () => {
    const { port, token } = await boot2();
    expect((await call(port, "/v1/info", { headers: { Authorization: "Bearer sk-nope" } })).status).toBe(401);
    expect((await call(port, "/v1/info", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await call(port, "/v1/info", { headers: { Authorization: "Bearer sk-bob-456" } })).status).toBe(200);
  });

  it("坏成员配置：启动就拒（重复 id / 空口令 / 口语与主口令相同）", async () => {
    await expect(boot({ members: [{ id: "a", token: "x" }, { id: "a", token: "y" }] })).rejects.toThrow(/重复/);
    await expect(boot({ members: [{ id: "  ", token: "x" }] })).rejects.toThrow(/缺 id/);
    await expect(boot({ members: [{ id: "a", token: "   " }] })).rejects.toThrow(/口令是空的/);
    await expect(boot({ token: "same-token", members: [{ id: "a", token: "same-token" }] })).rejects.toThrow(/与主口令相同/);
  });
});
