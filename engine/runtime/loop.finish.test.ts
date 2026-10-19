import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runTurn, type TurnEvent } from "./loop";
import { buildToolSet, createToolRegistry } from "./registry";
import { createTurnEvidence, describeFinish, validateFinish, type TurnEvidence } from "./finishContract";
import { FINISH_TOOL } from "../../shared/agentTools";
import type { ToolExecutor } from "../ports/executor";

/**
 * P0-02：主循环里的 finish 往返。
 *
 * 用本地假 provider（不烧钱、零出网）驱动真 SDK 流与真工具往返：
 * - 改了文件但没给命令证据 → finish 失败，循环继续；
 * - 先跑命令（退出码 0）再 finish → `TurnOutcome.finished.status === "done"`。
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

/** 一个按名分派的执行体：写文件/跑命令 + finish 走真校验。 */
function testExecutor(evidence: TurnEvidence): ToolExecutor {
  return {
    run: async (name, input) => {
      if (name === "write_file") return { ok: true, output: { line: "已写入", path: "src/sum.js" } };
      if (name === "run_command") return { ok: true, output: { line: "测试通过", exitCode: 0, text: "ok" } };
      if (name === FINISH_TOOL) {
        const got = validateFinish(input, evidence);
        if (!got.ok) return { ok: false, error: got.error };
        return { ok: true, output: { line: describeFinish(got.finish), finished: got.finish } };
      }
      return { ok: true, output: { line: "ok" } };
    },
  };
}

function toolsFor(evidence: TurnEvidence) {
  return buildToolSet({
    registry: createToolRegistry(),
    mode: "全部允许",
    executor: testExecutor(evidence),
    ctx: { mode: "全部允许", provider: "strata", turnEvidence: evidence },
  });
}

describe("主循环 · finish 完成契约", () => {
  it("改了文件但没给命令证据 → finish 变成错误，循环继续且不标记完成", async () => {
    const evidence = createTurnEvidence();
    script = () => {
      /* 按请求序号分三幕（同一个用例内顺序确定，不靠请求体里可能重复出现的文案） */
      if (bodies.length >= 3) return [text("明白，我去跑测试"), finish("stop")];
      if (bodies.length === 2) {
        return [toolChunk("c2", FINISH_TOOL, JSON.stringify({ status: "done", summary: "修好了" })), finish("tool_calls")];
      }
      return [
        toolChunk("c1", "write_file", JSON.stringify({ path: "src/sum.js", content: "x" })),
        finish("tool_calls"),
      ];
    };
    const events: TurnEvent[] = [];
    const outcome = await runTurn(
      {
        provider: "strata",
        messages: [{ role: "user", content: "修一下" }],
        tools: toolsFor(evidence),
        maxSteps: 4,
        turnEvidence: evidence,
      },
      (e) => events.push(e),
    );

    // finish 的结果里带的是错误（不是"已完成"）
    const finishResult = events.find(
      (e) => e.type === "tool-result" && (e as { toolName?: string }).toolName === FINISH_TOOL,
    ) as { error?: string } | undefined;
    expect(finishResult?.error).toContain("验证命令");
    // 循环被再拉了一轮（模型看到了错误并接着说）
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(outcome.finished).toBeUndefined();
    // 至少发出过第二轮之后的请求（write_file → finish → 再回答）
    expect(bodies.length).toBeGreaterThanOrEqual(3);
  });

  it("跑了命令（退出码 0）再 finish → outcome.finished 是 done", async () => {
    const evidence = createTurnEvidence();
    script = () => {
      if (bodies.length >= 3) return [text("完成了"), finish("stop")];
      if (bodies.length === 2) {
        return [
          toolChunk(
            "c2",
            FINISH_TOOL,
            JSON.stringify({
              status: "done",
              summary: "修好了",
              evidence: { commands: ["pnpm test"], files: ["src/sum.js"] },
            }),
          ),
          finish("tool_calls"),
        ];
      }
      return [toolChunk("c1", "run_command", JSON.stringify({ command: "pnpm test" })), finish("tool_calls")];
    };
    const events: TurnEvent[] = [];
    const outcome = await runTurn(
      {
        provider: "strata",
        messages: [{ role: "user", content: "修一下并验证" }],
        tools: toolsFor(evidence),
        maxSteps: 4,
        turnEvidence: evidence,
      },
      (e) => events.push(e),
    );

    expect(outcome.finished?.status).toBe("done");
    expect(outcome.finished?.evidence.commands).toEqual(["pnpm test"]);
    expect(events.some((e) => e.type === "tool-result" && (e as { toolName?: string }).toolName === FINISH_TOOL)).toBe(true);
  });
});
