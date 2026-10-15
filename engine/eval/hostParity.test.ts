import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildEngine } from "../../hosts/cli/assembly";
import { AcpAgent } from "../../hosts/acp/agent";
import { startFakeProvider } from "./fakeProvider";
import { EVAL_CASES } from "./cases";
import type { RpcMessage } from "../../hosts/acp/agent";

/**
 * 「接入外部宿主后**评测集零漂移**」（Phase 17 的验收口径）。
 *
 * ## 为什么值得单开一条
 *
 * 方案把这句写在 Phase 17 的验收里。它有两种可能的读法：
 *   · **结构性的**：外部宿主走的是同一份装配 + 同一条 `engine.run`，所以不会漂；
 *   · **可验证的**：拿同一批用例分别从两条路跑，结果一字不差。
 *
 * 「结构性成立」是我写在注释里的主张 —— 主张要能被证伪，所以这里做第二种：
 * **同一批用例，一次走内核直连、一次走 ACP 协议**，比对模型实际看见的与吐出的东西。
 *
 * ## 为什么只比"正文"，不比字节
 *
 * ACP 那条路的输出是 JSON-RPC 消息（多一层协议外壳），而直连那条是 TurnEvent 数组 ——
 * 比字节比的是外壳，不是行为。**要证的是"同一句话、同一个工具调用都到了"**，
 * 所以比的是：用户消息、模型回复文本、工具调用名与参数。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** 挑几条"判据与脚本无关"的用例（纯对话 —— 真模型与假 provider 都能同样地过）。 */
const CASES = EVAL_CASES.filter((c) => c.category === "纯对话" && c.kind !== "core").slice(0, 3);

describe("宿主一致性：内核直连 vs ACP（Phase 17 的「评测集零漂移」）", () => {
  it("同一批用例走两条路：用户消息、模型回复、工具调用都一致", async () => {
    expect(CASES.length, "没挑到用例（纯对话那类是不是被改了？）").toBeGreaterThan(0);

    for (const c of CASES) {
      const workDir = tmp(`dh-parity-${c.id}-`);
      const storeDir = tmp(`dh-parity-store-${c.id}-`);
      /*
       * ⚠️ **两条路各起一个假 provider**：它按"本实例收到第几个请求"取脚本，
       * 共用一个的话第一段会把脚本吃到最后一条，第二段就只能拿到重复的那条 ——
       * 那报出来的是"两条路正文不一样"，而真相是**测试装置串台**（第一版就是这么误报的）。
       */
      const prev = { base: process.env.STRATA_BASE_URL, key: process.env.STRATA_API_KEY };
      const directProvider = await startFakeProvider((c.replies ?? []).flat(), c.turns ?? []);
      let acpProvider: Awaited<ReturnType<typeof startFakeProvider>> | null = null;

      try {
        /* ① 直连：与评测集同一条路 */
        process.env.STRATA_BASE_URL = directProvider.url;
        process.env.STRATA_API_KEY = "parity-key";
        const direct = await buildEngine([workDir], storeDir);
        const events: Array<{ type: string; text?: string; toolName?: string }> = [];
        for (const turn of c.turns ?? []) {
          await direct.engine.run({
            sessionId: `parity-direct-${c.id}`,
            provider: "strata",
            model: "deepseek-flash",
            messages: [{ role: "user", content: turn }],
            mode: c.mode ?? "按需确认",
            useTools: true,
            maxSteps: c.maxSteps ?? 4,
            onEvent: (e) => events.push(e as { type: string; text?: string; toolName?: string }),
          });
        }
        direct.close();

        /* ② ACP：同一批用例从协议那头走一遍（**另一个 provider 实例 + 另一个 store 目录**） */
        acpProvider = await startFakeProvider((c.replies ?? []).flat(), c.turns ?? []);
        process.env.STRATA_BASE_URL = acpProvider.url;
        const acpStoreDir = tmp(`dh-parity-acp-${c.id}-`);
        const sent: RpcMessage[] = [];
        const agent = new AcpAgent({
          makeEngine: async (cwd: string) => buildEngine([cwd], acpStoreDir),
          mode: c.mode ?? "按需确认",
          provider: "strata",
          model: "deepseek-flash",
          send: (m) => sent.push(m),
        });
        await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: workDir, mcpServers: [] } }));
        const sessionId = String((sent.find((m) => m.id === 1)?.result as { sessionId: string }).sessionId);
        for (const turn of c.turns ?? []) {
          await agent.handleLine(
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: turn }] } }),
          );
        }

        /* ③ 比对：模型吐出的正文与调用的工具 */
        const directText = events.filter((e) => e.type === "text").map((e) => e.text ?? "").join("");
        const acpText = sent
          .filter((m) => m.method === "session/update")
          .map((m) => (m.params as { update: { sessionUpdate: string; content?: { text?: string } } }).update)
          .filter((u) => u.sessionUpdate === "agent_message_chunk")
          .map((u) => u.content?.text ?? "")
          .join("");
        expect(acpText, `${c.id}：两条路的正文不一样`).toBe(directText);

        const directTools = events.filter((e) => e.type === "tool-call").map((e) => e.toolName ?? "");
        const acpTools = sent
          .filter((m) => m.method === "session/update")
          .map((m) => (m.params as { update: { sessionUpdate: string; title?: string } }).update)
          .filter((u) => u.sessionUpdate === "tool_call")
          .map((u) => u.title ?? "");
        expect(acpTools, `${c.id}：两条路的工具调用不一样`).toEqual(directTools);
      } finally {
        await directProvider.close();
        if (acpProvider) await acpProvider.close();
        if (prev.base === undefined) delete process.env.STRATA_BASE_URL;
        else process.env.STRATA_BASE_URL = prev.base;
        if (prev.key === undefined) delete process.env.STRATA_API_KEY;
        else process.env.STRATA_API_KEY = prev.key;
      }
    }
  }, 120_000);
});
