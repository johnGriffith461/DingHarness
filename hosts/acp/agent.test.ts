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

function harness(events: Array<Record<string, unknown>> = [{ type: "text", text: "你好呀" }]) {
  const sent: RpcMessage[] = [];
  const agent = new AcpAgent({
    makeEngine: async () => ({
      engine: {
        async run(request: { onEvent?: (e: unknown) => void }) {
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
  return { agent, sent };
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
});
