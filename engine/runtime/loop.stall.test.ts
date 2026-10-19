import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runTurn, type TurnEvent } from "./loop";
import { buildToolSet, createToolRegistry } from "./registry";
import type { ToolExecutor } from "../ports/executor";

/**
 * P0-06：主循环里的重复调用检测。
 *
 * 假 provider 连续吐同一个工具调用；判据：
 * - 第 3 次出现时有一条 steer（提示换方法）；
 * - 第 5 次出现时这一轮停止，`error` 含"没有进展"，且 `aborted` 为 false
 *   （不是用户中止，是"模型卡住了"）。
 */
let port = 0;
let server: Server;
let bodies: unknown[] = [];
let script: (body: unknown) => object[] = () => [];

const CHUNK_BASE = { id: "c1", object: "chat.completion.chunk", created: 0, model: "deepseek-flash" };
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

const executor: ToolExecutor = {
  run: async () => ({ ok: true, output: { line: "还是一样" } }),
};

function tools() {
  return buildToolSet({
    registry: createToolRegistry(),
    mode: "全部允许",
    executor,
    ctx: { mode: "全部允许", provider: "strata" },
  });
}

describe("主循环 · 重复调用检测", () => {
  it("同一调用连续 5 次 → 第 3 次提示、第 5 次停止且 error 含「没有进展」", async () => {
    /* 每一次请求都吐同一个工具调用（同样的参数）—— 这就是"卡住"的形状 */
    script = () => [toolChunk("call_x", "read_file", '{"path":"a.md"}'), finish("tool_calls")];
    const events: TurnEvent[] = [];
    const outcome = await runTurn(
      {
        provider: "strata",
        messages: [{ role: "user", content: "读一下" }],
        tools: tools(),
        maxSteps: 10,
      },
      (e) => events.push(e),
    );

    const steers = events.filter((e) => e.type === "steer") as { text: string }[];
    expect(steers.length).toBeGreaterThanOrEqual(1);
    expect(steers[0]?.text).toContain("重复");
    expect(outcome.ok).toBe(false);
    expect(outcome.aborted).toBe(false);
    expect(outcome.error).toContain("没有进展");
    /* 停止发生在第 5 次调用附近，不会把 maxSteps 跑满 */
    expect(bodies.length).toBeLessThanOrEqual(6);
  });

  it("空响应（没有文本、没有工具）→ 明确报错，不当作成功", async () => {
    script = () => [finish("stop")];
    const outcome = await runTurn(
      { provider: "strata", messages: [{ role: "user", content: "你好" }] },
      () => undefined,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("没有返回任何内容");
  });
});
