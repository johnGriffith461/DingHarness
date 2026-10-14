/**
 * **AI SDK PoC 评估门**（Phase 6）。
 *
 * 换 SDK 是重大决策，所以先评后换。这个脚本把方案里的三项指标**跑出来**：
 *
 * | # | 指标 | 怎么判 |
 * |---|---|---|
 * | ① | prompt caching 可控性 | 把带缓存标注的请求发给一个假端点，**检查它真的被序列化进了请求体** |
 * | ② | 工具调用的确定性 | 同一份输入跑两遍，比较工具调用的**顺序与参数**；再验并行调用会不会乱序 |
 * | ③ | 中止 / 重试 / 步数语义 | 真中止、真数步数、工具报错是否被当成结果回注 |
 *
 * ## 为什么这样评（而不是"读文档说它支持"）
 *
 * 三项都要**可证伪**。尤其是 ①：文档里"支持 prompt caching"与实际"我们的请求体里
 * 真的带上了缓存标注"是两件事 —— 中间隔着一层适配器，而那一层正是最容易丢东西的地方。
 *
 * ## 成本
 *
 * 全程打在 `127.0.0.1` 的假端点上：**不发一次真请求**。
 * 所以它可以随时重跑（这也是它敢当门禁的前提）。
 *
 * 用法：
 * ```
 * node scripts/poc-sdk.mjs          # 跑三项并打印报告
 * ```
 * 结论与决策记在 `ADR/0001-sdk-选型.md`。
 */

import { createServer } from "node:http";

const results = [];
/** 假端点收到的请求体（检查"到底发出去了什么"的唯一依据）。 */
const seen = { bodies: [] };

const CHUNK_BASE = { id: "c1", object: "chat.completion.chunk", created: 0, model: "m" };
const text = (t) => ({ ...CHUNK_BASE, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
const finish = (r) => ({ ...CHUNK_BASE, choices: [{ index: 0, delta: {}, finish_reason: r }] });
const toolChunk = (id, name, args) => ({
  ...CHUNK_BASE,
  choices: [
    { index: 0, delta: { tool_calls: [{ index: 0, ...(id ? { id, type: "function" } : {}), function: { ...(name ? { name } : {}), arguments: args } }] }, finish_reason: null },
  ],
});
/** 一帧里带**两个并行**工具调用（检查并行会不会被拆散或乱序）。 */
const parallelTools = (a, b) => ({
  ...CHUNK_BASE,
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [
          { index: 0, id: a.id, type: "function", function: { name: a.name, arguments: a.args } },
          { index: 1, id: b.id, type: "function", function: { name: b.name, arguments: b.args } },
        ],
      },
      finish_reason: null,
    },
  ],
});

/** 假端点：记下请求体，按当前脚本（`mode`）吐响应。 */
let mode = "simple";
let port = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* 不是 JSON 也记下来（比如 Anthropic 那条也不是 JSON 就说明出问题了） */
    }
    seen.bodies.push({ url: req.url, headers: req.headers, body: parsed ?? body });

    /*
     * Anthropic 的协议不是 OpenAI 那套 —— ① 只关心**请求体**，回一个能解析的错就走。
     *
     * ⚠️ 路径是 `/v1/messages` 还是 `/messages` 取决于 baseURL 里带不带 `/v1`：
     * SDK 是**直接拼** baseURL 的。实测踩过：baseURL 不带 `/v1` 时它发到 `/messages`，
     * 而真实端点在 `/v1/messages` → 404。所以 provider 表里 anthropic 那条
     * baseURL 写的是 `https://api.anthropic.com/v1`（带版本段）。
     */
    if (req.url?.includes("/messages")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "poc: 只要请求体" } }));
      return;
    }

    const chunks =
      mode === "parallel"
        ? [
            parallelTools({ id: "p1", name: "read_file", args: '{"path":"a.md"}' }, { id: "p2", name: "list_dir", args: '{"path":"."}' }),
            finish("tool_calls"),
          ]
        : mode === "tool-error"
          ? [toolChunk("t1", "read_file", '{"path":"a.md"}'), finish("tool_calls")]
          : [text("好"), finish("stop")];

    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
port = server.address().port;

/* 这两个环境变量必须在 import 引擎之前设好 —— provider 表在模块求值时就定下了默认值。 */
process.env.STRATA_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.STRATA_API_KEY = "poc-key";
process.env.ANTHROPIC_BASE_URL_FOR_POC = `http://127.0.0.1:${port}`;

const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
const { createAnthropic } = await import("@ai-sdk/anthropic");
const { generateText } = await import("ai");
const { runTurn } = await import("../engine/runtime/loop.ts");
const { createToolRegistry, buildToolSet } = await import("../engine/runtime/registry.ts");

const record = (n, name, ok, detail) => {
  results.push({ n, name, ok, detail });
  process.stdout.write(`${ok ? "✓" : "✗"} 指标${n} ${name}\n    ${detail}\n`);
};

/* ────────────────── ① prompt caching 可控性 ────────────────── */
try {
  // baseURL 带 `/v1`：与 provider 表里 anthropic 那条的写法一致（见上面注释）
  const anthropic = createAnthropic({ apiKey: "poc", baseURL: `http://127.0.0.1:${port}/v1` });
  const model = anthropic("claude-sonnet-4-5");
  const CACHE = { anthropic: { cacheControl: { type: "ephemeral" } } };

  /*
   * ⚠️ 三种写法都试 —— 因为"能不能控"这件事的关键不是"有没有这个选项"，
   * 而是**哪一种写法真的会被序列化进请求体**（文档里写着支持、实际发不出去，
   * 是最容易骗过自己的形态）。实测：三种都会带上，粒度不同而已。
   */
  const shapes = [
    { name: "调用级 providerOptions", call: () => generateText({ model, prompt: "hi", providerOptions: CACHE }) },
    {
      name: "消息分片级（只给这一段打标）",
      call: () =>
        generateText({
          model,
          messages: [{ role: "user", content: [{ type: "text", text: "hi", providerOptions: CACHE }] }],
        }),
    },
    {
      name: "系统提示词 + 分片级（缓存一个长系统提示）",
      call: () =>
        generateText({
          model,
          system: "很长的系统提示词。".repeat(50),
          messages: [{ role: "user", content: [{ type: "text", text: "hi", providerOptions: CACHE }] }],
        }),
    },
  ];

  const hits = [];
  for (const shape of shapes) {
    seen.bodies.length = 0;
    let err = null;
    await shape.call().catch((e) => { err = e; });
    const sent = seen.bodies.find((b) => b.url?.includes("/messages"));
    const body = typeof sent?.body === "string" ? sent.body : JSON.stringify(sent?.body ?? "");
    if (body.includes("cache_control") && body.includes("ephemeral")) hits.push(shape.name);
  }
  record(
    1,
    "prompt caching 可控性",
    hits.length > 0,
    hits.length
      ? `三种写法里 ${hits.length} 种真的把 cache_control 序列化进了请求体（${hits.join("、")}）—— **调用方可控**`
      : `请求体里没有 cache_control —— 也就是说标注发不出去（文档支持 ≠ 实际发得出去）。诊断：收到 ${seen.bodies.length} 个请求，URL ${seen.bodies.map((b) => b.url).join(" | ") || "（一个都没有）"}`,
  );
} catch (error) {
  record(1, "prompt caching 可控性", false, `探测本身失败：${String(error).slice(0, 120)}`);
}

/* ────────────────── ② 工具调用的确定性 ────────────────── */
try {
  const registry = createToolRegistry();
  const tools = buildToolSet({
    registry,
    mode: "全部允许",
    executor: { run: async (name) => ({ ok: true, output: { line: `${name} 好了` } }) },
    ctx: { mode: "全部允许", provider: "strata" },
  });

  /** 跑一轮，收集工具调用的"名字+参数"序列。 */
  const runOnce = async (m) => {
    mode = m;
    const calls = [];
    await runTurn({ provider: "strata", messages: [{ role: "user", content: "x" }], tools, maxSteps: 2 }, (e) => {
      if (e.type === "tool-call") calls.push(`${e.toolName}:${JSON.stringify(e.input)}`);
    });
    return calls;
  };

  const first = await runOnce("simple");
  const second = await runOnce("simple");
  /*
   * 并行那一条用 maxSteps=1：假端点每轮都回同一套 chunk，
   * 多给几步就会拿到"同一批并行调用重复 N 次"——那是我假端点的行为，不是被测语义。
   */
  const parallel = await (async () => {
    mode = "parallel";
    const calls = [];
    await runTurn({ provider: "strata", messages: [{ role: "user", content: "x" }], tools, maxSteps: 1 }, (e) => {
      if (e.type === "tool-call") calls.push(`${e.toolName}:${JSON.stringify(e.input)}`);
    });
    return calls;
  })();
  const same = JSON.stringify(first) === JSON.stringify(second);
  const parallelOk = parallel.length === 2 && parallel[0].startsWith("read_file") && parallel[1].startsWith("list_dir");
  record(
    2,
    "工具调用的确定性",
    same && parallelOk,
    `同一输入两遍：${same ? "序列完全一致" : `不一致（${first.join("|")} vs ${second.join("|")}）`}；` +
      `并行调用：${parallelOk ? "两个都在且按到达顺序" : `被拆散或乱序：${parallel.join("|")}`}`,
  );
} catch (error) {
  record(2, "工具调用的确定性", false, `探测本身失败：${String(error).slice(0, 120)}`);
}

/* ────────────────── ③ 中止 / 重试 / 步数语义 ────────────────── */
try {
  // 中止：流中点了停止 → aborted=true，且**不**判 provider 失败
  mode = "simple";
  const controller = new AbortController();
  const abortOutcome = await runTurn(
    { provider: "strata", messages: [{ role: "user", content: "x" }], abortSignal: controller.signal },
    (e) => {
      if (e.type === "text") controller.abort();
    },
  );

  // 步数：上限是参数，数得准
  mode = "tool-error";
  const tools = buildToolSet({
    registry: createToolRegistry(),
    mode: "全部允许",
    executor: {
      run: async () => {
        throw new Error("poc：故意失败");
      },
    },
    ctx: { mode: "全部允许", provider: "strata" },
  });
  let steps = 0;
  const events = [];
  const stepOutcome = await runTurn(
    { provider: "strata", messages: [{ role: "user", content: "x" }], tools, maxSteps: 3 },
    (e) => {
      events.push(e.type);
      if (e.type === "step-finish") steps += 1;
    },
  );

  const abortedOk = abortOutcome.aborted === true && abortOutcome.ok === true;
  const stepsOk = steps === 3;
  // 工具抛错 → 是 tool-result（带 error），整轮不中断
  const errorInjected = events.includes("tool-result") && stepOutcome.ok === true;
  record(
    3,
    "中止 / 重试 / 步数语义",
    abortedOk && stepsOk && errorInjected,
    `中止：${abortedOk ? "aborted=true 且 ok=true（中止不算失败）" : "语义不对"}；` +
      `步数：maxSteps=3 实测 ${steps} 步${stepsOk ? "" : "（对不上）"}；` +
      `工具报错：${errorInjected ? "作为 tool-result 回注、整轮继续" : "没有回注"}`,
  );
} catch (error) {
  record(3, "中止 / 重试 / 步数语义", false, `探测本身失败：${String(error).slice(0, 120)}`);
}

server.close();

/* ────────────────── 报告 ────────────────── */
const allOk = results.every((r) => r.ok);
process.stdout.write(
  [
    "",
    "=== PoC 结论 ===",
    ...results.map((r) => `${r.ok ? "通过" : "未通过"}　指标${r.n} ${r.name}`),
    "",
    allOk
      ? "三项全通过 → 选项 A（保留 AI SDK + 官方 provider 包）成立，不需要换 SDK。"
      : "有指标未通过 → 按方案规则：停在选项 A，并把「未通过的那一项」如实记进 ADR，不强行换 SDK。",
    "决策与证据见 ADR/0001-sdk-选型.md。",
    "",
  ].join("\n"),
);
process.exit(0);
