import { randomBytes } from "node:crypto";

/**
 * OTLP trace 导出（V6-2h）。
 *
 * ## 为什么自己写、不引 OpenTelemetry SDK
 *
 * 我们只需要**一种东西**：把"一轮请求"（外加它里面的工具调用）按 OTLP/HTTP JSON
 * 发出去。官方 SDK 是完整 instrumentation 框架（自动埋点、采样、exporter 生命周期），
 * 引进来会给一个本地优先的桌面应用凭空加几十个依赖 —— 而协议本身只是
 * `POST <endpoint>/v1/traces` 一个 JSON。
 *
 * ## 默认关闭（本地主权的一条硬规矩）
 *
 * 没有 `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
 * 就**一个网络请求都不发**。这是"默认零遥测"在实现上的落点：不是界面上一个开关，
 * 是"没配就根本没有这条代码路径"。
 *
 * 环境变量（与 OTel 规范同名，别自造）：
 *   · `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` —— 完整 URL（优先）
 *   · `OTEL_EXPORTER_OTLP_ENDPOINT` —— 基地址，自动补 `/v1/traces`
 *   · `OTEL_EXPORTER_OTLP_HEADERS` —— `k=v,k2=v2`
 *   · `OTEL_SERVICE_NAME` —— 默认 `ding-harness`
 *   · `DH_OTLP_TIMEOUT_MS` —— 超时（默认 5000）
 *
 * ## 导不出去不影响跑
 *
 * 导出是**旁路**：失败只写 stderr（而且只在 debug 下），不抛、不重试、不阻塞。
 * 一轮对话不该因为 collector 没起来而失败。
 */

/** 导出配置（从环境变量收窄）。 */
export type OtlpConfig = {
  /** 完整 traces 端点。 */
  endpoint: string;
  headers: Record<string, string>;
  serviceName: string;
  timeoutMs: number;
};

/** 一次工具调用的时间片。 */
export type ToolSpanInput = {
  name: string;
  startedAt: number;
  endedAt: number;
  ok: boolean;
  toolCallId?: string;
};

/** 一轮请求的 span 输入。 */
export type TurnSpanInput = {
  sessionId?: string;
  provider: string;
  model: string;
  startedAt: number;
  /** 从 provider 的 usage 里拿；没有就按现在的时刻收尾（不编延时）。 */
  elapsedMs?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  ok: boolean;
  error?: string;
  tools?: readonly ToolSpanInput[];
  /** 测试注入（不注入就随机）。 */
  ids?: { traceId?: string; spanId?: string };
};

/**
 * 从环境变量读配置。
 *
 * @param env 环境（默认 `process.env`）
 * @returns 配置；没配端点 → null（= 不导出）
 */
export function otlpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OtlpConfig | null {
  const explicit = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const endpoint = explicit || (base ? `${base.replace(/\/+$/, "")}/v1/traces` : "");
  if (!endpoint) return null;
  const headers: Record<string, string> = {};
  for (const pair of (env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    headers[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  const timeout = Number(env.DH_OTLP_TIMEOUT_MS);
  return {
    endpoint,
    headers,
    serviceName: env.OTEL_SERVICE_NAME?.trim() || "ding-harness",
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 5000,
  };
}

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

/** 毫秒 → OTLP 的纳秒字符串（用 BigInt，避免 53 位精度丢位）。 */
function nanos(ms: number): string {
  return (BigInt(Math.max(0, Math.floor(ms))) * 1_000_000n).toString();
}

/** 一个属性值（只支持 OTLP 的四种标量里我们用的三种）。 */
function attr(key: string, value: string | number | boolean): Record<string, unknown> {
  if (typeof value === "number") return { key, value: { intValue: Math.trunc(value) } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return { key, value: { stringValue: value } };
}

/**
 * 把一轮请求构造成 OTLP/HTTP JSON（**纯函数**，好测）。
 *
 * @param input 一轮的输入
 * @param config 配置（用 serviceName）
 * @returns `{ resourceSpans: [...] }` 形状的请求体
 */
export function buildTurnTrace(input: TurnSpanInput, config: Pick<OtlpConfig, "serviceName">): Record<string, unknown> {
  const traceId = input.ids?.traceId ?? hex(16);
  const spanId = input.ids?.spanId ?? hex(8);
  const endAt = input.startedAt + Math.max(0, input.elapsedMs ?? 0);
  const rootAttrs = [
    attr("service.name", config.serviceName),
    attr("gen_ai.system", input.provider),
    attr("gen_ai.request.model", input.model),
    attr("ding.provider", input.provider),
    attr("ding.model", input.model),
    ...(input.sessionId ? [attr("ding.session_id", input.sessionId)] : []),
    ...(input.usage?.inputTokens !== undefined ? [attr("gen_ai.usage.input_tokens", input.usage.inputTokens)] : []),
    ...(input.usage?.outputTokens !== undefined ? [attr("gen_ai.usage.output_tokens", input.usage.outputTokens)] : []),
    ...(input.elapsedMs !== undefined ? [attr("ding.elapsed_ms", input.elapsedMs)] : []),
    ...(input.tools?.length ? [attr("ding.tool_calls", input.tools.length)] : []),
  ];

  const spans: Record<string, unknown>[] = [
    {
      traceId,
      spanId,
      name: "ding.turn",
      kind: 1,
      startTimeUnixNano: nanos(input.startedAt),
      endTimeUnixNano: nanos(endAt),
      attributes: rootAttrs,
      status: input.ok ? { code: 1 } : { code: 2, message: (input.error ?? "failed").slice(0, 200) },
      ...(input.ok ? {} : { droppedAttributesCount: 0 }),
    },
  ];

  for (const tool of input.tools ?? []) {
    spans.push({
      traceId,
      spanId: hex(8),
      parentSpanId: spanId,
      name: `ding.tool.${tool.name || "unknown"}`,
      kind: 1,
      startTimeUnixNano: nanos(tool.startedAt),
      endTimeUnixNano: nanos(tool.endedAt),
      attributes: [attr("ding.tool.name", tool.name), ...(tool.toolCallId ? [attr("ding.tool_call_id", tool.toolCallId)] : [])],
      status: tool.ok ? { code: 1 } : { code: 2 },
    });
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: [attr("service.name", config.serviceName)] },
        scopeSpans: [{ scope: { name: "ding.harness", version: "1" }, spans }],
      },
    ],
  };
}

/**
 * 导出一轮（**不抛**）。
 *
 * @param input 一轮的输入
 * @param opts.env 环境（测试注入）
 * @param opts.fetchImpl fetch（测试注入）
 * @returns 真的发出去了返回 true（没配端点、或失败都返回 false）
 */
export async function exportTurnTrace(
  input: TurnSpanInput,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const config = otlpConfigFromEnv(opts.env);
  if (!config) return false;
  const body = JSON.stringify(buildTurnTrace(input, config));
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await doFetch(config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...config.headers },
        body,
        signal: controller.signal,
      });
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* collector 没起来 / 网络不通：**不影响这一轮**（旁路就该有旁路的自觉） */
    return false;
  }
}
