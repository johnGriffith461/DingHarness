#!/usr/bin/env node
/**
 * 测试用的**外部 ACP agent**（V6-3f）。
 *
 * 只实现客户端那条路要用的四个方法与一种通知：
 * `initialize` / `session/new` / `session/prompt` / `session/cancel` +
 * `session/update`（agent_message_chunk / tool_call）。
 *
 * 它不是产品的一部分：`ding acp-drive` 的回归拿它当"对端"，
 * 这样测的是我们客户端的协议实现，而不是某个第三方 agent 的脾气。
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
let cancelled = false;

const send = (message) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (message.method === "session/new") {
    send({ id: message.id, result: { sessionId: "fake-session-1" } });
    return;
  }
  if (message.method === "session/cancel") {
    cancelled = true;
    return;
  }
  if (message.method === "session/prompt") {
    const sessionId = message.params?.sessionId;
    const asked = message.params?.prompt?.[0]?.text ?? "";
    send({
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `收到：${asked}` } } },
    });
    send({
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "读文件", status: "pending" } },
    });
    send({ id: message.id, result: { stopReason: cancelled ? "cancelled" : "end_turn" } });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: `没有这个方法：${message.method}` } });
});

/* 父进程关 stdin 就退出（不留孤儿） */
rl.on("close", () => process.exit(0));
