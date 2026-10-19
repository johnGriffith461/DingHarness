import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runTurn, type TurnEvent } from "./loop";
import { buildToolSet, createToolRegistry } from "./registry";
import { createTurnEvidence, describeFinish, validateFinish, type TurnEvidence } from "./finishContract";
import { FINISH_TOOL } from "../../shared/agentTools";
import type { ToolExecutor } from "../ports/executor";

/**
 * P0-03：完成提醒。
 *
 * 判据：
 * - 第一轮改了文件、没 finish → **再发一次请求**，且消息里有"finish"；
 * - 第一轮有有效 finish → 不再追加；
 * - 第一轮被 abort → 不再追加；
 * - 提醒只拉一次（第二轮仍没有就收尾，标记 unfinished）。
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

function executor(evidence: TurnEvidence): ToolExecutor {
  return {
    run: async (name, input) => {
      if (name === "write_file") return { ok: true, output: { line: "已写入", path: "a.ts" } };
      if (name === "run_command") return { ok: true, output: { line: "ok", exitCode: 0 } };
      if (name === FINISH_TOOL) {
        const got = validateFinish(input, evidence);
        return got.ok
          ? { ok: true, output: { line: describeFinish(got.finish), finished: got.finish } }
          : { ok: false, error: got.error };
      }
      return { ok: true, output: { line: "ok" } };
    },
  };
}

function toolsFor(evidence: TurnEvidence) {
  return buildToolSet({
    registry: createToolRegistry(),
    mode: "全部允许",
    executor: executor(evidence),
    ctx: { mode: "全部允许", provider: "strata", turnEvidence: evidence },
  });
}

function includesReminder(body: unknown): boolean {
  return JSON.stringify(body ?? "").includes("completion_reminder");
}

describe("主循环 · 完成提醒", () => {
  it("改了文件但没 finish → 再拉一轮，消息里含 finish", async () => {
    const evidence = createTurnEvidence();
    script = () => {
      /* 第一轮：写文件；之后（同一次请求的第二次 streamText）只回文本 */
      if (bodies.length === 1) return [toolChunk("c1", "write_file", '{"path":"a.ts","content":"x"}'), finish("tool_calls")];
      return [text("我改好了"), finish("stop")];
    };
    const events: TurnEvent[] = [];
    const outcome = await runTurn(
      {
        provider: "strata",
        messages: [{ role: "user", content: "改一下 a.ts" }],
        tools: toolsFor(evidence),
        maxSteps: 3,
        turnEvidence: evidence,
      },
      (e) => events.push(e),
    );

    expect(outcome.unfinished).toBe(true);
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    /* 最后那一次请求带的就是提醒 */
    expect(includesReminder(bodies[bodies.length - 1])).toBe(true);
    expect(events.some((e) => e.type === "steer")).toBe(true);
    /* 只提醒一次（不会无限循环） */
    expect(bodies.filter((b) => includesReminder(b)).length).toBe(1);
  });

  it("第一轮有有效 finish → 不追加提醒", async () => {
    const evidence = createTurnEvidence();
    script = () => {
      if (bodies.length === 1) return [toolChunk("c1", "run_command", '{"command":"pnpm test"}'), finish("tool_calls")];
      if (bodies.length === 2) {
        return [
          toolChunk(
            "c2",
            FINISH_TOOL,
            JSON.stringify({ status: "done", summary: "好了", evidence: { commands: ["pnpm test"] } }),
          ),
          finish("tool_calls"),
        ];
      }
      return [text("完成"), finish("stop")];
    };
    const outcome = await runTurn(
      {
        provider: "strata",
        messages: [{ role: "user", content: "修好并验证" }],
        tools: toolsFor(evidence),
        maxSteps: 4,
        turnEvidence: evidence,
      },
      () => undefined,
    );

    expect(outcome.finished?.status).toBe("done");
    expect(bodies.some((b) => includesReminder(b))).toBe(false);
  });

  it("第一轮被 abort → 不追加提醒", async () => {
    const evidence = createTurnEvidence();
    const controller = new AbortController();
    script = () => [text("先看看"), finish("stop")];
    const outcome = await runTurn(
      {
        provider: "strata",
        messages: [{ role: "user", content: "随便" }],
        tools: toolsFor(evidence),
        maxSteps: 2,
        turnEvidence: evidence,
        abortSignal: controller.signal,
      },
      (e) => {
        if (e.type === "text") controller.abort();
      },
    );

    expect(outcome.aborted).toBe(true);
    expect(bodies.some((b) => includesReminder(b))).toBe(false);
  });
});
