import { createCipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { askAgentViaChannel, replyFromSse } from "./agentClient";
import { openSeenStore } from "./dedupe";
import { createFeishuReplier, decryptFeishu, feishuSignature, parseFeishuEvent, verifyFeishuSignature, type FeishuConfig } from "./feishu";
import { createImServer } from "./server";
import { createSlackReplier, parseSlackEvent, slackSignature, verifySlackSignature, type SlackConfig } from "./slack";
import { handleIncoming, type IncomingMessage } from "./types";

/**
 * IM 身份桥（V6-2f）。
 *
 * 平台凭据无法在 CI 里真连，所以这里测的是**协议实现**：
 * 验签/解密/解析/去重/回复请求的形状 —— 每一条都用平台文档里的算法独立算一遍。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dh-im-"));
  dirs.push(d);
  return d;
};

/** 按飞书的算法加密（测试里自己做一遍，证明解密实现是照着文档写的）。 */
function encryptFeishu(payload: unknown, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final()]);
  return Buffer.concat([iv, data]).toString("base64");
}

const feishuMessage = (over: Record<string, unknown> = {}) => ({
  schema: "2.0",
  header: { event_id: "ev-1", event_type: "im.message.receive_v1", token: "vt" },
  event: {
    sender: { sender_id: { open_id: "ou-1" } },
    message: {
      message_id: "om-1",
      chat_id: "oc-1",
      message_type: "text",
      content: JSON.stringify({ text: '<at user_id="ou_bot">Ding</at> 你好' }),
    },
  },
  ...over,
});

describe("飞书", () => {
  it("签名：配了 encryptKey 才要求，算法是 sha256(ts+nonce+key+body)", () => {
    const body = "{}";
    const sig = feishuSignature("1700000000", "n", "key", body);
    expect(verifyFeishuSignature({ timestamp: "1700000000", nonce: "n", signature: sig, rawBody: body, encryptKey: "key" })).toBe(true);
    expect(verifyFeishuSignature({ timestamp: "1700000000", nonce: "n", signature: "bad", rawBody: body, encryptKey: "key" })).toBe(false);
    expect(verifyFeishuSignature({ rawBody: body })).toBe(true);
  });

  it("解密往返；challenge 原样回", () => {
    const payload = feishuMessage();
    expect(decryptFeishu(encryptFeishu(payload, "k1"), "k1")).toEqual(payload);
    expect(parseFeishuEvent({ type: "url_verification", challenge: "c1", token: "vt" }, "vt")).toEqual({ kind: "challenge", challenge: "c1" });
  });

  it("消息解析：剥 @ 标记，拿 user/chat/eventId", () => {
    const got = parseFeishuEvent(feishuMessage(), "vt");
    expect(got.kind).toBe("message");
    if (got.kind !== "message") return;
    expect(got.message).toMatchObject({ platform: "feishu", eventId: "ev-1", userId: "ou-1", chatId: "oc-1", text: "你好" });
  });

  it("token 不匹配 / 非文本消息 → ignore（不猜）", () => {
    expect(parseFeishuEvent(feishuMessage({ header: { token: "other" } }), "vt").kind).toBe("ignore");
    const file = feishuMessage();
    file.event.message.content = JSON.stringify({ file_key: "x" });
    file.event.message.message_type = "file";
    expect(parseFeishuEvent(file, "vt").kind).toBe("ignore");
  });

  it("回复器：先取 tenant token，再按 chat_id 发文本", async () => {
    const calls: { url: string; body: string }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body ?? "") });
      if (String(url).includes("tenant_access_token")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-1", expire: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    const config: FeishuConfig = { appId: "a", appSecret: "s", verificationToken: "vt", apiBase: "https://feishu.test" };
    const reply = createFeishuReplier(config, fake);
    const got = await reply({ platform: "feishu", eventId: "e", userId: "u", chatId: "oc-1", text: "x" }, "答案");
    expect(got.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]!.body)).toMatchObject({ receive_id: "oc-1", msg_type: "text" });
    expect(JSON.parse(JSON.parse(calls[1]!.body).content)).toEqual({ text: "答案" });
  });
});

describe("Slack", () => {
  it("签名 + 5 分钟时间窗", () => {
    const body = '{"type":"event_callback"}';
    const ts = "1700000000";
    const sig = slackSignature("secret", ts, body);
    expect(verifySlackSignature({ timestamp: ts, signature: sig, rawBody: body, signingSecret: "secret", now: 1_700_000_000_000 })).toBe(true);
    expect(verifySlackSignature({ timestamp: ts, signature: sig, rawBody: body, signingSecret: "secret", now: 1_700_001_000_000 })).toBe(false);
    expect(verifySlackSignature({ timestamp: ts, signature: "v0=bad", rawBody: body, signingSecret: "secret", now: 1_700_000_000_000 })).toBe(false);
  });

  it("解析：忽略 bot/子类型；剥 <@U> 提及", () => {
    const body = {
      type: "event_callback",
      event_id: "Ev1",
      event: { type: "message", user: "U1", channel: "C1", text: "<@U2> 你好" },
    };
    const got = parseSlackEvent(body);
    expect(got.kind).toBe("message");
    if (got.kind === "message") expect(got.message).toMatchObject({ eventId: "Ev1", userId: "U1", chatId: "C1", text: "你好" });
    expect(parseSlackEvent({ ...body, event: { ...body.event, bot_id: "B1" } }).kind).toBe("ignore");
    expect(parseSlackEvent({ ...body, event: { ...body.event, subtype: "message_changed" } }).kind).toBe("ignore");
  });

  it("回复器：chat.postMessage + Bearer", async () => {
    const calls: { auth?: string; body: string }[] = [];
    const fake = (async (_url: string, init?: RequestInit) => {
      calls.push({ auth: (init?.headers as Record<string, string> | undefined)?.authorization, body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const config: SlackConfig = { signingSecret: "s", botToken: "xoxb-1", apiBase: "https://slack.test" };
    const got = await createSlackReplier(config, fake)({ platform: "slack", eventId: "e", userId: "u", chatId: "C1", text: "x" }, "答案");
    expect(got.ok).toBe(true);
    expect(calls[0]!.auth).toBe("Bearer xoxb-1");
    expect(JSON.parse(calls[0]!.body)).toEqual({ channel: "C1", text: "答案" });
  });
});

describe("去重与桥接", () => {
  it("去重表落盘、重启后仍记得（平台会在几秒后重投）", () => {
    const file = path.join(tmp(), "seen.json");
    const a = openSeenStore(file);
    a.add("ev-1");
    expect(a.has("ev-1")).toBe(true);
    const b = openSeenStore(file);
    expect(b.has("ev-1")).toBe(true);
    expect(b.size()).toBe(1);
  });

  it("同一条事件只问一次 agent（重复投递不重复执行）", async () => {
    const seen = openSeenStore(path.join(tmp(), "seen.json"));
    let asked = 0;
    const replied: string[] = [];
    const deps = {
      askAgent: async () => {
        asked += 1;
        return "答案";
      },
      reply: async (_m: IncomingMessage, text: string) => {
        replied.push(text);
        return { ok: true };
      },
      seen,
    };
    const message: IncomingMessage = { platform: "feishu", eventId: "ev-9", userId: "u", chatId: "c", text: "你好" };
    expect(await handleIncoming(message, deps)).toBe("replied");
    expect(await handleIncoming(message, deps)).toBe("duplicate");
    expect(asked).toBe(1);
    expect(replied).toEqual(["答案"]);
  });

  it("agent 失败也会回一句（不沉默）", async () => {
    const seen = openSeenStore(path.join(tmp(), "seen.json"));
    const replied: string[] = [];
    await handleIncoming(
      { platform: "slack", eventId: "e", userId: "u", chatId: "c", text: "x" },
      {
        askAgent: async () => {
          throw new Error("连不上");
        },
        reply: async (_m, text) => {
          replied.push(text);
          return { ok: true };
        },
        seen,
      },
    );
    expect(replied[0]).toContain("没跑完");
  });

  it("agent 客户端：从 SSE 里取 done.reply", async () => {
    const sse = 'event: started\ndata: {"sessionId":"s"}\n\nevent: done\ndata: {"reply":"最终答案"}\n\n';
    expect(replyFromSse(sse)).toBe("最终答案");
    const fake = (async () => new Response(sse, { status: 200 })) as unknown as typeof fetch;
    const got = await askAgentViaChannel({ baseURL: "http://127.0.0.1:1", token: "t", channel: "feishu", from: "u", text: "x", fetchImpl: fake });
    expect(got).toBe("最终答案");
  });
});

describe("webhook 服务", () => {
  it("飞书 challenge 原样回；消息先 ACK 再以 bot 身份回复；重投不重复执行", async () => {
    const dataDir = tmp();
    const fetches: string[] = [];
    const fakeFetch = (async (url: string) => {
      fetches.push(String(url));
      if (String(url).includes("tenant_access_token")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t", expire: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    let asked = 0;

    const im = createImServer({
      config: {
        agent: { url: "http://127.0.0.1:1", token: "t" },
        feishu: { appId: "a", appSecret: "s", verificationToken: "vt", apiBase: "https://feishu.test" },
      },
      seenFile: path.join(dataDir, "seen.json"),
      fetchImpl: fakeFetch,
      askAgent: async () => {
        asked += 1;
        return "收到";
      },
      log: () => undefined,
    });
    await new Promise<void>((resolve) => im.server.listen(0, "127.0.0.1", () => resolve()));
    const base = `http://127.0.0.1:${im.port()}`;
    try {
      const challenge = await fetch(`${base}/im/feishu`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "url_verification", challenge: "c1", token: "vt" }),
      });
      expect(await challenge.json()).toEqual({ challenge: "c1" });

      const send = () =>
        fetch(`${base}/im/feishu`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(feishuMessage()),
        });
      expect((await send()).status).toBe(200);
      /* 回复是异步的：等它出现（最多 2 秒） */
      for (let i = 0; i < 40 && !fetches.some((u) => u.includes("/im/v1/messages")); i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(fetches.some((u) => u.includes("/im/v1/messages"))).toBe(true);

      await send(); // 重投
      await new Promise((r) => setTimeout(r, 150));
      expect(asked).toBe(1);
    } finally {
      await im.close();
    }
  });

  it("白名单：不在名单里的人不回、也不问 agent", async () => {
    const im = createImServer({
      config: {
        agent: { url: "http://127.0.0.1:1", token: "t" },
        feishu: { appId: "a", appSecret: "s", verificationToken: "vt", apiBase: "https://feishu.test" },
        allowUsers: ["ou-allowed"],
      },
      seenFile: path.join(tmp(), "seen.json"),
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      askAgent: async () => {
        throw new Error("不该问");
      },
      log: () => undefined,
    });
    await new Promise<void>((resolve) => im.server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const res = await fetch(`http://127.0.0.1:${im.port()}/im/feishu`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(feishuMessage()),
      });
      expect(await res.json()).toMatchObject({ ok: true, ignored: "user not allowed" });
    } finally {
      await im.close();
    }
  });
});

describe("配置", () => {
  it("缺 agent / 平台凭据不完整 → 明确报错", async () => {
    const { loadImConfig } = await import("./config");
    const dir = tmp();
    const file = path.join(dir, "im.json");
    fs.writeFileSync(file, JSON.stringify({ agent: { url: "http://x" } }), "utf8");
    expect(loadImConfig(file).ok).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ agent: { url: "http://x", token: "t" }, feishu: { appId: "a" } }), "utf8");
    expect(loadImConfig(file).ok).toBe(false);
    fs.writeFileSync(
      file,
      JSON.stringify({ agent: { url: "http://x", token: "t" }, feishu: { appId: "a", appSecret: "s", verificationToken: "v" } }),
      "utf8",
    );
    expect(loadImConfig(file).ok).toBe(true);
  });
});

/**
 * **G12：审批卡的 HTTP 接线**（2026-10-18）。
 *
 * 这里不启动真的 agent/平台，而是给 IM 服务注入一个假 fetch，把三条请求分开：
 *  - 平台回复（`/open-apis/im/v1/messages`）→ 记下回给用户的话；
 *  - 待批查询（`/v1/approvals?session=`）→ 第一次给一条 pending；
 *  - 处置（`POST /v1/approvals/<会话>/<调用>`）→ 记下 action。
 *
 * 判据：一轮跑完会发一张卡；回 `yes <码>` 会真的去处置并回执；
 * 同一个码再回一次会得到"已经处理过了"。
 */
describe("G12：审批卡（HTTP 接线）", () => {
  it("一轮结束后发卡；`yes <码>` 去服务端处置；重复处置被拒", async () => {
    const dataDir = tmp();
    const replies: string[] = [];
    const decisions: Array<{ url: string; body: unknown }> = [];
    const sessionId = "ch-feishu-ou-1";

    const fakeFetch = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("tenant_access_token")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t", expire: 7200 }), { status: 200 });
      }
      if (url.includes("/open-apis/im/v1/messages")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { content?: string };
        replies.push(JSON.parse(body.content ?? "{}").text ?? "");
        return new Response(JSON.stringify({ code: 0 }), { status: 200 });
      }
      if (/\/v1\/approvals\?session=/.test(url)) {
        /* 第一次查询给一条待批；处置之后给空（模拟服务端已处理） */
        const approvals = decisions.length
          ? []
          : [
              {
                sessionId,
                toolCallId: "call-1",
                name: "write_file",
                state: "pending",
                approvers: ["local"],
                youCanDecide: true,
                createdAt: Date.now(),
              },
            ];
        return new Response(JSON.stringify({ approvals }), { status: 200 });
      }
      if (/\/v1\/approvals\//.test(url) && init?.method === "POST") {
        decisions.push({ url, body: JSON.parse(String(init.body ?? "{}")) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const im = createImServer({
      config: {
        agent: { url: "http://127.0.0.1:1", token: "t" },
        feishu: { appId: "a", appSecret: "s", verificationToken: "vt", apiBase: "https://feishu.test" },
      },
      seenFile: path.join(dataDir, "seen.json"),
      fetchImpl: fakeFetch,
      askAgent: async () => "这一轮写文件前被闸门拦住了",
      log: () => undefined,
    });
    await new Promise<void>((resolve) => im.server.listen(0, "127.0.0.1", () => resolve()));
    const base = `http://127.0.0.1:${im.port()}`;

    const send = (text: string, eventId: string) =>
      fetch(`${base}/im/feishu`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema: "2.0",
          header: { event_id: eventId, event_type: "im.message.receive_v1", token: "vt" },
          event: {
            sender: { sender_id: { open_id: "ou-1" } },
            message: {
              message_id: `om-${eventId}`,
              chat_id: "oc-1",
              message_type: "text",
              content: JSON.stringify({ text }),
            },
          },
        }),
      });

    const waitFor = async (predicate: () => boolean, why: string): Promise<void> => {
      for (let i = 0; i < 60 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 50));
      expect(predicate(), why).toBe(true);
    };

    try {
      expect((await send("写一个文件", "ev-10")).status).toBe(200);
      await waitFor(() => replies.length >= 2, `应该收到两句话（回复 + 卡），实际：${JSON.stringify(replies)}`);

      const card = replies.find((r) => r.includes("yes ")) ?? "";
      expect(card, "没发审批卡").toContain("等你批准");
      const code = /yes ([a-z0-9]{4})/.exec(card)?.[1] ?? "";
      expect(code, "卡上没有短码").not.toBe("");

      /* 回 yes <码>：不该再问 agent、应该去服务端处置 */
      expect((await send(`yes ${code}`, "ev-11")).status).toBe(200);
      await waitFor(() => replies.some((r) => r.includes("已批准")), `没看到批准回执：${JSON.stringify(replies)}`);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.url).toContain(`/v1/approvals/${encodeURIComponent(sessionId)}/call-1`);
      expect(decisions[0]!.body).toMatchObject({ action: "approve" });

      /* 同一个码再回一次 → 已经处理过 */
      await send(`yes ${code}`, "ev-12");
      await waitFor(
        () => replies.some((r) => r.includes("已经") && r.includes("批")),
        `重复处置没有回执：${JSON.stringify(replies)}`,
      );
    } finally {
      await im.close();
    }
  });

  it("卡片不属于当前会话 → 拒绝处置（防截图外泄）", async () => {
    /* 直接测登记处与会话校验的组合，不必再起一遍服务 */
    const { createCardRegistry } = await import("./approvalCards");
    const registry = createCardRegistry({ now: () => 1000, random: () => 0.1 });
    const card = registry.add({
      sessionId: "s1",
      toolCallId: "c1",
      name: "write_file",
      summary: "x",
      chat: "oc-1",
      platform: "feishu",
    });
    expect(card.chat).toBe("oc-1");
    expect(card.code).toMatch(/^[a-z0-9]{4}$/);
  });
});
