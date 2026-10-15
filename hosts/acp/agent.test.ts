import { describe, expect, it } from "vitest";

import { AcpAgent, ACP_PROTOCOL_VERSION, textOfPrompt, type RpcMessage } from "./agent";

/**
 * ACP agent（Phase 17）。
 *
 * ## 测什么
 *
 * 协议形状（**照着官方 schema 的字段名**，不是猜的）：`initialize` 回 capabilities、
 * `session/new` 回 `sessionId`、`session/prompt` 流式推 `session/update` 之后回 `stopReason`、
 * 不认识的**通知**按规范忽略（不能回错误 —— 通知没有 id 可回）。
 *
 * ## 不起真模型
 *
 * 注入一个假引擎（把 `onEvent` 喂两条事件），于是这一组是**协议层**的测试：
 * 毫秒级、不需要 key、也不碰磁盘。
 */

function harness(events: Array<Record<string, unknown>> = [{ type: "text", text: "你好呀" }], behaviour: { hang?: boolean } = {}) {
  const sent: RpcMessage[] = [];
  let aborted = 0;
  const agent = new AcpAgent({
    makeEngine: async () => ({
      engine: {
        async run(request: { onEvent?: (e: unknown) => void; abortSignal?: AbortSignal }) {
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
          for (const e of events) request.onEvent?.(e);
          return { ok: true, aborted: false, events: [], records: [], requestId: "r1", provider: "fake", model: "fake" };
        },
        async resume() {
          return { turns: [], pending: [] };
        },
        tools: {},
      },
      close: () => undefined,
    }) as never,
    mode: "按需确认",
    provider: "fake",
    send: (m) => sent.push(m),
  });
  return {
    agent,
    sent,
    get aborted() {
      return aborted;
    },
  };
}

/** 取某条响应的 result。 */
const resultOf = (sent: RpcMessage[], id: number) => sent.find((m) => m.id === id)?.result as Record<string, unknown>;
/** 取所有通知（没有 id 的那些）。 */
const notifications = (sent: RpcMessage[]) => sent.filter((m) => m.id === undefined && m.method === "session/update");

describe("ACP agent（Phase 17）", () => {
  it("① initialize：回协议版本、能力与自己的名字", async () => {
    const { agent, sent } = harness();
    await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }));
    const result = resultOf(sent, 1);
    expect(result.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    expect(result.agentCapabilities).toMatchObject({ loadSession: true });
    expect((result.agentInfo as { name: string }).name).toBe("ding-harness");
  });

  it("② session/new：回 `sessionId`（字段名照 schema）", async () => {
    const { agent, sent } = harness();
    await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } }));
    const result = resultOf(sent, 2);
    expect(typeof result.sessionId).toBe("string");
    expect(String(result.sessionId).length).toBeGreaterThan(3);
  });

  it("③ session/new 缺 cwd：报参数错（不是拿当前目录顶上）", async () => {
    const { agent, sent } = harness();
    await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/new", params: {} }));
    expect(sent.find((m) => m.id === 3)?.error?.message).toContain("cwd");
  });

  it("④ session/prompt：正文以 `session/update` 流式推出，最后回 stopReason", async () => {
    const { agent, sent } = harness([{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }]);
    await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } }));
    const sid = String(resultOf(sent, 1).sessionId);
    await agent.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "你好" }] } }),
    );

    const updates = notifications(sent);
    expect(updates.length).toBe(2);
    const first = updates[0]!.params as { sessionId: string; update: { sessionUpdate: string; content: { type: string; text: string } } };
    expect(first.sessionId).toBe(sid);
    expect(first.update.sessionUpdate).toBe("agent_message_chunk");
    expect(first.update.content).toEqual({ type: "text", text: "第一段" });
    expect(resultOf(sent, 2).stopReason).toBe("end_turn");
  });

  it("⑤ 工具调用也推（in_progress → completed），外部宿主看得见它在干什么", async () => {
    const { agent, sent } = harness([
      { type: "tool-call", toolCallId: "c1", toolName: "list_dir", input: { path: "." } },
      { type: "tool-result", toolCallId: "c1", toolName: "list_dir", output: {} },
    ]);
    await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } }));
    const sid = String(resultOf(sent, 1).sessionId);
    await agent.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "看看目录" }] } }),
    );
    const updates = notifications(sent).map((m) => (m.params as { update: { sessionUpdate: string; status?: string } }).update);
    expect(updates[0]).toMatchObject({ sessionUpdate: "tool_call", status: "in_progress" });
    expect(updates[1]).toMatchObject({ sessionUpdate: "tool_call_update", status: "completed" });
  });

  it("⑥ 不认识的**通知**按规范忽略（通知没有 id，不能回错误）", async () => {
    const { agent, sent } = harness();
    await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "some/notification", params: {} }));
    expect(sent).toEqual([]);
  });

  it("⑦ 不认识的**请求**回 -32601（而不是静默）", async () => {
    const { agent, sent } = harness();
    await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "nope", params: {} }));
    expect(sent.find((m) => m.id === 9)?.error?.code).toBe(-32601);
  });

  it("⑧ 不是 JSON 的一行：回解析错误而不是崩（协议通道上不能抛）", async () => {
    const { agent, sent } = harness();
    await agent.handleLine("这不是 json");
    expect(sent[0]?.error?.code).toBe(-32700);
  });

  it("⑨ 空行忽略（客户端可能会发空行）", async () => {
    const { agent, sent } = harness();
    await agent.handleLine("   ");
    expect(sent).toEqual([]);
  });

  it("⑩ 没有那段会话时 prompt 报参数错（不是随便挑一段跑）", async () => {
    const { agent, sent } = harness();
    await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "session/prompt", params: { sessionId: "nope", prompt: [{ type: "text", text: "x" }] } }));
    expect(sent.find((m) => m.id === 5)?.error?.message).toContain("没有这段会话");
  });

  it("⑪ 取文本：只认 text 与 resource_link，别的忽略（不报错）", () => {
    expect(textOfPrompt([{ type: "text", text: "甲" }, { type: "image", data: "…" }, { type: "text", text: "乙" }])).toBe("甲\n乙");
    expect(textOfPrompt([{ type: "resource_link", uri: "file:///x.md" }])).toContain("file:///x.md");
    expect(textOfPrompt("不是数组")).toBe("");
  });

  it("⭐ ⑫ 被闸门拦下的工具（pending）对外报 failed，不是 completed", async () => {
    /*
     * 审计 P176：闸门拦下时工具返回 `{pending:true, notice:…}`，**没有 error 字段** ——
     * 只按 error 判会把"根本没执行"上报成绿的 `completed`。
     */
    const { agent, sent } = harness([
      { type: "tool-call", toolCallId: "c1", toolName: "write_file", input: { path: "x" } },
      { type: "tool-result", toolCallId: "c1", toolName: "write_file", output: { pending: true, notice: "已交给用户确认……还没有执行" } },
    ]);
    await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } }));
    const sid = String(resultOf(sent, 1).sessionId);
    await agent.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "写个文件" }] } }),
    );
    const updates = notifications(sent).map((m) => (m.params as { update: { sessionUpdate: string; status?: string } }).update);
    expect(updates[1]).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
  });

  it("⭐ ⑬ 引擎抛错 → 如实回 JSON-RPC error（不是伪装成 end_turn 的成功）", async () => {
    const sent: RpcMessage[] = [];
    const agent = new AcpAgent({
      makeEngine: async () => {
        throw new Error("provider 401：密钥不认");
      },
      mode: "按需确认",
      provider: "fake",
      send: (m) => sent.push(m),
    });
    await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } }));
    const sid = String(resultOf(sent, 1).sessionId);
    await agent.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "你好" }] } }),
    );
    const response = sent.find((m) => m.id === 2);
    expect(response?.error, "这一轮炸了却回了成功形状").toBeTruthy();
    expect(response?.result).toBeUndefined();
    /*
     * 失败走 JSON-RPC error 而不是自编一条 `session/update`（ACP 类型表里没有 "error"）——
     * 这里顺带钉住"没有编造的通知飞出去"。
     */
    expect(notifications(sent).some((m) => (m.params as { update: { sessionUpdate: string } }).update.sessionUpdate === "error")).toBe(false);
  });

  it("⭐ ⑬b 引擎返回「没跑成」（ok:false）→ 也是 error，不是 end_turn", async () => {
    const sent: RpcMessage[] = [];
    const agent = new AcpAgent({
      makeEngine: async () => ({
        engine: {
          async run() {
            return { ok: false, error: "模型超时", aborted: false, events: [], records: [], requestId: "r1", provider: "fake", model: "fake" };
          },
          async resume() {
            return { turns: [], pending: [] };
          },
          tools: {},
        },
        close: () => undefined,
      }) as never,
      mode: "按需确认",
      provider: "fake",
      send: (m) => sent.push(m),
    });
    await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: process.cwd() } }));
    const sid = String(resultOf(sent, 1).sessionId);
    await agent.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "你好" }] } }),
    );
    expect(sent.find((m) => m.id === 2)?.error).toBeTruthy();
    expect(sent.find((m) => m.id === 2)?.result).toBeUndefined();
  });

  it("⭐ ⑭ cwd 授权不过 → session/new 直接报参数错（不是先给 sessionId 再在 prompt 时才炸）", async () => {
    const sent: RpcMessage[] = [];
    const agent = new AcpAgent({
      makeEngine: async () => {
        throw new Error("不该走到这");
      },
      authorizeCwd: (raw) =>
        raw.startsWith(process.cwd()) && raw !== process.cwd() + "-evil"
          ? { ok: true, cwd: raw }
          : { ok: false, reason: `工作目录不在授权范围内：${raw}` },
      mode: "按需确认",
      provider: "fake",
      send: (m) => sent.push(m),
    });
    await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: process.cwd() + "-evil" } }));
    expect(sent.find((m) => m.id === 3)?.error?.message).toContain("授权范围");
  });

  it("⭐ ⑮ session/cancel 能在一轮跑完之前读到（不再被 await 串行化挡在后面）", async () => {
    /*
     * 审计 P175：`for await { await handleLine(line) }` 会让 prompt 挡住 cancel。
     * 这一条按**读侧**的真实形状测：prompt 不 await，紧接着把 cancel 喂进去。
     */
    const session = harness([], { hang: true });
    const { agent, sent } = session;
    await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } }));
    const sid = String(resultOf(sent, 1).sessionId);

    const promptRun = agent.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "慢慢想" }] } }),
    );
    await new Promise((r) => setTimeout(r, 30)); // 让 prompt 挂到 abortSignal 上
    await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: sid } }));
    await promptRun;

    expect(session.aborted, "cancel 没有真的中止那一轮").toBe(1);
    expect(resultOf(sent, 2).stopReason).toBe("cancelled");
  });

  it("⭐ ⑯ 同一段会话并发第二个 prompt → 明确拒绝（而不是排队装没事）", async () => {
    const { agent, sent } = harness([], { hang: true });
    await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } }));
    const sid = String(resultOf(sent, 1).sessionId);
    const first = agent.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "第一句" }] } }),
    );
    await new Promise((r) => setTimeout(r, 30));
    await agent.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "第二句" }] } }),
    );
    expect(sent.find((m) => m.id === 3)?.error?.code).toBe(-32603);
    await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: sid } }));
    await first;
  });

  it("⭐ ⑰ 超长的一行：判解析错误，不吞进内存，也不弄崩进程", async () => {
    const { agent, sent } = harness();
    await agent.handleLine("x".repeat(1_000_001));
    expect(sent[0]?.error?.code).toBe(-32700);
    /* 后面的正常行照常处理 */
    await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "initialize", params: {} }));
    expect(sent.some((m) => m.id === 4 && m.result)).toBe(true);
  });

  it("⭐ ⑱ 会话数上限：满了淘汰最旧的**空闲**会话（淘汰是可见的，不是悄悄挤）", async () => {
    const { agent, sent } = harness();
    let firstId = "";
    for (let i = 1; i <= 65; i += 1) {
      await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: i, method: "session/new", params: { cwd: process.cwd() } }));
      if (i === 1) firstId = String(resultOf(sent, 1).sessionId);
    }
    /* 第 65 个把第 1 个挤掉了（上限 64）→ 对它的 prompt 报"没有这段会话" */
    expect(resultOf(sent, 65).sessionId).toBeTruthy();
    await agent.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 999, method: "session/prompt", params: { sessionId: firstId, prompt: [{ type: "text", text: "还在吗" }] } }),
    );
    expect(sent.find((m) => m.id === 999)?.error?.message).toContain("没有这段会话");
  });
});
