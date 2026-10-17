import path from "node:path";
import { describe, expect, it } from "vitest";

import { AcpClient, type AcpUpdate } from "./client";

/**
 * ACP 客户端（V6-3f）：Ding 驱动**外部** agent。
 *
 * 对端用仓内的小假 agent（`fakeAcpAgent.mjs`）：测的是我们的协议实现，
 * 不是某个第三方 agent 的脾气。判据：握手 → 开会话 → 发一轮 →
 * 收到 `session/update` 通知 → 拿到 `stopReason` → 关掉不留孤儿。
 */

const FIXTURE = path.join(__dirname, "fakeAcpAgent.mjs");

describe("ACP 客户端", () => {
  it("⭐ 握手 → 开会话 → 一轮：文本更新与 tool_call 都收到，stopReason 是 end_turn", async () => {
    const client = AcpClient.spawn({
      command: process.execPath,
      args: [FIXTURE],
      cwd: __dirname,
      timeoutMs: 15_000,
    });
    const updates: AcpUpdate[] = [];
    client.onUpdate((update) => updates.push(update));
    try {
      const init = await client.initialize();
      expect(init.protocolVersion).toBe(1);

      const sessionId = await client.newSession(process.cwd());
      expect(sessionId).toBe("fake-session-1");

      const result = await client.prompt(sessionId, "做一件事");
      expect(result.stopReason).toBe("end_turn");

      const texts = updates
        .map((u) => u.update)
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => (u.content as { text?: string } | undefined)?.text ?? "");
      expect(texts.join("")).toContain("收到：做一件事");
      expect(updates.some((u) => u.update.sessionUpdate === "tool_call")).toBe(true);
      /* 通知都带 sessionId（客户端据此分流） */
      expect(updates.every((u) => u.sessionId === "fake-session-1")).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("对端报错 → 请求 reject（不把失败报成成功）", async () => {
    const client = AcpClient.spawn({ command: process.execPath, args: [FIXTURE], cwd: __dirname, timeoutMs: 15_000 });
    try {
      await client.initialize();
      /* 直接调一个假 agent 没实现的方法 */
      await expect(
        (client as unknown as { request: (method: string, params: unknown) => Promise<unknown> }).request("nope/method", {}),
      ).rejects.toThrow(/没有这个方法/);
    } finally {
      await client.close();
    }
  });

  it("进程起不来：请求会 reject（而不是挂到超时）", async () => {
    const client = AcpClient.spawn({ command: "definitely-not-a-real-command-xyz", args: [], timeoutMs: 2000 });
    try {
      await expect(client.initialize()).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});
