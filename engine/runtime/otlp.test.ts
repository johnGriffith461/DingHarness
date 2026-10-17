import { describe, expect, it, vi } from "vitest";

import { buildTurnTrace, exportTurnTrace, otlpConfigFromEnv } from "./otlp";

/**
 * OTLP 导出（V6-2h）。
 *
 * 三条判据：
 *   ① **没配端点 = 一个请求都不发**（默认零遥测的落点，不是界面开关）；
 *   ② span 形状是 OTLP/HTTP JSON（traceId/spanId/纳秒时间戳/attributes/status）；
 *   ③ 导出失败**不影响这一轮**（collector 没起来不该让对话失败）。
 */

describe("配置（环境变量）", () => {
  it("没配端点 → null（= 不导出）", () => {
    expect(otlpConfigFromEnv({})).toBeNull();
    expect(otlpConfigFromEnv({ OTEL_SERVICE_NAME: "x" })).toBeNull();
  });

  it("基地址自动补 /v1/traces；显式端点优先", () => {
    expect(otlpConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" })?.endpoint).toBe(
      "http://localhost:4318/v1/traces",
    );
    expect(
      otlpConfigFromEnv({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://a",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://b/custom",
      })?.endpoint,
    ).toBe("http://b/custom");
  });

  it("headers、service.name、超时都有默认值与收窄", () => {
    const cfg = otlpConfigFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://x/",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer t, x-team = blue ,bad",
      DH_OTLP_TIMEOUT_MS: "1234",
    })!;
    expect(cfg.headers).toEqual({ authorization: "Bearer t", "x-team": "blue" });
    expect(cfg.serviceName).toBe("ding-harness");
    expect(cfg.timeoutMs).toBe(1234);
  });
});

describe("span 形状", () => {
  const input = {
    sessionId: "task-1",
    provider: "deepseek",
    model: "deepseek-chat",
    startedAt: 1_700_000_000_000,
    elapsedMs: 1500,
    usage: { inputTokens: 100, outputTokens: 50 },
    ok: true,
    tools: [
      { name: "read_file", startedAt: 1_700_000_000_100, endedAt: 1_700_000_000_200, ok: true, toolCallId: "c1" },
      { name: "run_command", startedAt: 1_700_000_000_300, endedAt: 1_700_000_000_400, ok: false },
    ],
    ids: { traceId: "a".repeat(32), spanId: "b".repeat(16) },
  };

  it("根 span + 每个工具一个子 span（parentSpanId 指向根）", () => {
    const body = buildTurnTrace(input, { serviceName: "ding-test" }) as {
      resourceSpans: { resource: { attributes: unknown[] }; scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    };
    const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(3);
    expect(spans[0]).toMatchObject({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      name: "ding.turn",
      status: { code: 1 },
    });
    /* 纳秒：毫秒 × 1e6（用字符串，避免浮点丢位） */
    expect(spans[0]!.startTimeUnixNano).toBe("1700000000000000000");
    expect(spans[0]!.endTimeUnixNano).toBe("1700000001500000000");
    for (const child of spans.slice(1)) {
      expect(child.parentSpanId).toBe("b".repeat(16));
      expect(String(child.name)).toMatch(/^ding\.tool\./);
    }
    /* 失败的工具 span 带 error 状态 */
    expect(spans[2]!.status).toEqual({ code: 2 });
  });

  it("失败的一轮：根 span 状态是 error，并带 message", () => {
    const body = buildTurnTrace({ ...input, ok: false, error: "上游 502" }, { serviceName: "s" }) as {
      resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    };
    expect(body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.status).toEqual({ code: 2, message: "上游 502" });
  });
});

describe("导出", () => {
  it("没配端点：不调 fetch，返回 false", async () => {
    const fetchImpl = vi.fn();
    expect(await exportTurnTrace({ provider: "p", model: "m", startedAt: 0, ok: true }, { env: {}, fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("配了端点：POST 到 /v1/traces，带 content-type 与自定义头", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    const ok = await exportTurnTrace(
      { provider: "p", model: "m", startedAt: 0, elapsedMs: 10, ok: true },
      { env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318", OTEL_EXPORTER_OTLP_HEADERS: "x-team=blue" }, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(ok).toBe(true);
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("http://127.0.0.1:4318/v1/traces");
    expect(call[1]?.method).toBe("POST");
    expect(call[1]?.headers).toMatchObject({ "content-type": "application/json", "x-team": "blue" });
  });

  it("collector 没起来：返回 false，不抛（旁路就该有旁路的自觉）", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(
      await exportTurnTrace(
        { provider: "p", model: "m", startedAt: 0, ok: true },
        { env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1" }, fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).toBe(false);
  });
});
