import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runTurn, type TurnEvent } from "./loop";
import { buildToolSet, createToolRegistry } from "./registry";
import type { ToolExecutor } from "../ports/executor";

/**
 * T-02：**待审批挂起回合**。
 *
 * ## 缺陷形状（WorkBuddy 实测）
 *
 * 闸门把待审批当成一条**普通工具结果** `{ pending: true }` 返回给模型；
 * 模型于是拿着"还没执行"继续生成，甚至直接 `finish(status="blocked")` 收尾。
 * 用户点了「允许」之后工具确实执行了，但那一轮已经结束了 ——
 * 模型自己的话是：「那次收尾的文案和事实对不上」。
 *
 * ## 判据
 *
 * - 出现 `pending` 的那一步结束就停（不再发第二次请求）；
 * - `TurnOutcome.awaitingApproval` 有值（谁在等、等哪一个）；
 * - **不会**触发完成提醒（等批时不许催 finish）。
 */
let port = 0;
let server: Server;
let bodies: unknown[] = [];
let script: (body: unknown) => object[] = () => [];

const CHUNK_BASE = { id: "c1", object: "chat.completion.chunk", created: 0, model: "deepseek-flash" };
const text = (t: string) => ({ ...CHUNK_BASE, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
const finish = (reason: string) => ({ ...CHUNK_BASE, choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const toolChunk = (id: string, name: string, args: string) => ({
  ...CHUNK_BASE,
  choices: [
    {
      index: 0,
      delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] },
      finish_reason: null,
    },
  ],
});

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += String(d)));
    req.on("end", () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      bodies.push(parsed);
      const chunks = script(parsed);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  process.env.STRATA_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.STRATA_API_KEY = "test-key";
});

afterAll(async () => {
  delete process.env.STRATA_BASE_URL;
  delete process.env.STRATA_API_KEY;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  bodies = [];
  script = () => [];
});

/** 执行体：写文件时**返回 pending**（就是闸门拦下时的形状）。 */
const gatedExecutor: ToolExecutor = {
  run: async (name) =>
    name === "write_file"
      ? {
          ok: true,
          output: { pending: true, notice: "已把这次「write_file」交给用户确认，**还没有执行**。" },
        }
      : { ok: true, output: { line: "ok" } },
};

function tools() {
  return buildToolSet({
    registry: createToolRegistry(),
    mode: "按需确认",
    executor: gatedExecutor,
    ctx: { mode: "按需确认", provider: "strata" },
  });
}

describe("主循环 · 待审批挂起", () => {
  it("⭐ 出现 pending 就停：不再发第二次请求，也不催 finish", async () => {
    /*
     * 模型先写文件（被拦）→ 按旧行为它会接着说"我改好了"，
     * 而 P0-03 的完成提醒还会再拉一轮。两条都不该发生。
     */
    script = (body) => {
      const raw = JSON.stringify(body ?? "");
      if (raw.includes("已把这次")) return [text("好，等你确认。"), finish("stop")];
      return [toolChunk("c1", "write_file", '{"path":"a.ts","content":"x"}'), finish("tool_calls")];
    };
    const events: TurnEvent[] = [];
    const outcome = await runTurn(
      {
        provider: "strata",
        messages: [{ role: "user", content: "改一下 a.ts" }],
        tools: tools(),
        maxSteps: 6,
      },
      (e) => events.push(e),
    );

    expect(outcome.awaitingApproval).toMatchObject({ toolCallId: "c1", name: "write_file" });
    /* 只发了一次请求：pending 那一步之后没有再拉一轮 */
    expect(bodies.length).toBe(1);
    /* 没有完成提醒 */
    expect(events.some((e) => e.type === "steer" && /completion_reminder/.test(e.text))).toBe(false);
    /* T-02：待审批**不算写过文件**（写根本没执行） */
    expect(outcome.wroteFiles).toBeUndefined();
    /* 也不算"失败"：它在等人，不是出错 */
    expect(outcome.ok).toBe(true);
    expect(outcome.unfinished).toBeUndefined();
  });

  it("没有 pending 的一轮行为不变（不误判 awaitingApproval）", async () => {
    script = () => [text("直接回答"), finish("stop")];
    const outcome = await runTurn(
      { provider: "strata", messages: [{ role: "user", content: "你好" }] },
      () => undefined,
    );
    expect(outcome.awaitingApproval).toBeUndefined();
    expect(outcome.ok).toBe(true);
  });
});
