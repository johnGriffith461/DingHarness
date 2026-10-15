import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { startAgentServer } from "./agentServer";

/**
 * Agent Server（Phase 17）。
 *
 * ## 这里验的三件事
 *
 * 1. **默认只绑回环**；对外绑定**没 token 就起不来**（硬拒，不是警告）——
 *    这条不是"配置约定"，是"agent 能读写你的文件、跑命令"这条事实的直接后果；
 * 2. token 走 `Authorization: Bearer`，**错 token 一律 401**；
 * 3. 接口形状（`/healthz` 不要 token、`/v1/info` 说实话）。
 *
 * ## 不起真模型
 *
 * `makeEngine` 是注入的 —— 这里给一个假的（只记下被问了什么、返回能跑的最小对象）。
 * 于是这一组测的是**协议与安全口径**，跑起来是毫秒级、且不需要任何 key。
 */

function fakeEngineFactory() {
  const opened: string[] = [];
  return {
    opened,
    makeEngine: async (cwd: string) => {
      opened.push(cwd);
      return {
        engine: {
          async run(request: { onEvent?: (e: unknown) => void }) {
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
    makeEngine: (cwd: string) => Promise<{ engine: never; close: () => void }>;
  };
}

/** 起一个服务并拿它的地址（端口给 0 = 系统分配）。 */
async function boot(over: Partial<Parameters<typeof startAgentServer>[0]> = {}) {
  const fake = fakeEngineFactory();
  const started = await startAgentServer({
    port: 0,
    makeEngine: fake.makeEngine as never,
    mode: "按需确认",
    provider: "fake",
    cwd: process.cwd(),
    ...over,
  });
  return { ...started, fake };
}

describe("Agent Server（Phase 17）", () => {
  it("① 默认只绑回环（不给 bind 时是本机地址）", async () => {
    const { server, url } = await boot();
    try {
      expect(url).toContain("127.0.0.1");
    } finally {
      server.close();
    }
  });

  it("⭐ ② 对外绑定**没给 token 就起不来**（硬拒，不是警告）", async () => {
    await expect(boot({ bind: "0.0.0.0" })).rejects.toThrow(/token/);
  });

  it("③ 对外绑定给了 token 就能起来", async () => {
    const { server } = await boot({ bind: "0.0.0.0", token: "s3cret" });
    server.close();
  });

  it("④ /healthz 不要 token（探活）；/v1/info 要", async () => {
    const { server, port } = await boot({ bind: "0.0.0.0", token: "s3cret" });
    try {
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);

      const noToken = await fetch(`http://127.0.0.1:${port}/v1/info`);
      expect(noToken.status).toBe(401);

      const wrong = await fetch(`http://127.0.0.1:${port}/v1/info`, { headers: { authorization: "Bearer nope" } });
      expect(wrong.status).toBe(401);

      const ok = await fetch(`http://127.0.0.1:${port}/v1/info`, { headers: { authorization: "Bearer s3cret" } });
      expect(ok.status).toBe(200);
      const info = (await ok.json()) as { name: string; mode: string; hooks: string[] };
      expect(info.name).toBe("ding-harness");
      /* 外部宿主该知道"写与执行会不会被拦" */
      expect(info.mode).toBe("按需确认");
      expect(Array.isArray(info.hooks)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("⑤ POST /v1/run 是 SSE：事件按 `event: …` 推出来，最后一条 done", async () => {
    const { server, port } = await boot();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "你好" }),
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("event: event");
      expect(text).toContain('"type":"text"');
      expect(text).toContain("event: done");
    } finally {
      server.close();
    }
  });

  it("⑥ /v1/run 没有 message 就 400（不是跑一轮空提示）", async () => {
    const { server, port } = await boot();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it("⑦ webhook：配过的名字能跑，没配的 404 且**说清有哪些**", async () => {
    const { server, port } = await boot({ hooks: { nightly: "汇总今天的对话" } });
    try {
      const bad = await fetch(`http://127.0.0.1:${port}/v1/hooks/nope`, { method: "POST" });
      expect(bad.status).toBe(404);
      expect(((await bad.json()) as { error: string }).error).toContain("nightly");

      const ok = await fetch(`http://127.0.0.1:${port}/v1/hooks/nightly`, { method: "POST" });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain("event: done");
    } finally {
      server.close();
    }
  });

  it("⑧ 不认识的路径 404（而不是静默成功）", async () => {
    const { server, port } = await boot();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/nope`);
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("⑨ 请求体有上限（别让一个超大 body 把内存吃光）", async () => {
    const { server, port } = await boot();
    try {
      /*
       * 超限时服务端**直接把连接掐掉**（比"读完再报错"更省内存）——
       * 所以这里要接受两种拒绝形态：一个错误状态码，或者连接被 reset。
       * 判据是"**没有跑成功**"，不是"回了哪个码"。
       */
      let rejected = false;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "x".repeat(1_100_000) }),
        });
        rejected = res.status >= 400;
      } catch {
        rejected = true; // ECONNRESET：连接被掐了，也算拒绝
      }
      expect(rejected, "超大请求体竟然跑通了").toBe(true);
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
