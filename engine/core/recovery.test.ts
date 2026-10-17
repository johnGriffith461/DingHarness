import { describe, expect, it } from "vitest";

import { chatSessionId, resumeSession, type LogInput, type LogRecord } from "./events";
import { interruptedTurns, recoveryViewOf } from "./recovery";

/**
 * 崩溃恢复（Phase 12.2）。
 *
 * ## 判据为什么长这样
 *
 * "这一轮跑完了没有"不需要额外的状态位 —— 事件流里本来就有答案：
 * 有 `done`/`error` 就是收尾，**都没有就是被打断了**。
 * 所以下面每条用例都在验同一件事：**从记录本身能不能认出来**。
 */

let seq = 0;
function rec<T extends LogInput["type"]>(requestId: string, type: T, extra: Record<string, unknown> = {}): LogRecord {
  seq += 1;
  return { seq, at: 1000 + seq, requestId, type, ...extra } as unknown as LogRecord;
}

function request(requestId: string, text: string): LogRecord {
  seq += 1;
  return {
    seq,
    at: 1000 + seq,
    requestId,
    type: "request",
    provider: "strata",
    model: "m",
    messages: [{ role: "user", content: text }],
    toolPolicy: "按需确认",
    tools: [],
  } as unknown as LogRecord;
}

describe("崩溃恢复：认出被打断的回合（Phase 12.2）", () => {
  it("① 有 done 的回合不算被打断", () => {
    const records = [request("r1", "你好"), rec("r1", "text", { text: "在的" }), rec("r1", "done")];
    expect(interruptedTurns(records)).toEqual([]);
  });

  it("② 有 error 的回合也算收尾（报错与中止都是「结束了」）", () => {
    const errored = [request("r1", "跑一下"), rec("r1", "error", { message: "连不上 provider" })];
    expect(interruptedTurns(errored), "报错收尾被误判成被打断").toEqual([]);
    // 中止就是 `error` 里写的"已中止"（engine/index.ts 的口径）—— 同一条路
    const aborted = [request("r1", "跑一下"), rec("r1", "error", { message: "已中止" })];
    expect(interruptedTurns(aborted)).toEqual([]);
  });

  it("③ 没有终止记录的回合 = 被打断，且带出「它当时做到哪了」", () => {
    const records = [
      request("r1", "帮我看一下这个目录"),
      rec("r1", "tool-call", { toolCallId: "c1", toolName: "list_dir", input: {} }),
      rec("r1", "tool-result", { toolCallId: "c1", toolName: "list_dir", output: {} }),
      rec("r1", "text", { text: "目录里有三个文件，其中" }),
    ];
    const got = interruptedTurns(records);
    expect(got.length).toBe(1);
    expect(got[0]!.requestId).toBe("r1");
    // 用户那句原话要带出来（恢复时界面/命令行要显示"你当时说的是这句"）
    expect(got[0]!.userMessage).toBe("帮我看一下这个目录");
    // 已经做过几步（工具调用次数）与最后那句话都要有 —— 用户据此判断"要不要继续"
    expect(got[0]!.stepsDone).toBe(1);
    expect(got[0]!.lastText).toContain("目录里有三个文件");
  });

  it("④ 多轮里只有被打断的那一轮被认出来（后面正常的回合不受影响）", () => {
    const records = [
      request("r1", "第一句"),
      rec("r1", "done"),
      request("r2", "第二句（这一轮被打断）"),
      rec("r2", "text", { text: "说到一半" }),
      request("r3", "第三句"),
      rec("r3", "done"),
    ];
    const got = interruptedTurns(records);
    expect(got.map((t) => t.requestId)).toEqual(["r2"]);
    expect(got[0]!.userMessage).toContain("被打断");
  });

  it("⑤ 待决审批也在恢复视图里（走投影，不另存状态位）", () => {
    const records = [
      request("r1", "写个文件"),
      rec("r1", "tool-call", { toolCallId: "c1", toolName: "write_file", input: { path: "a.txt" } }),
      rec("r1", "tool-result", {
        toolCallId: "c1",
        toolName: "write_file",
        output: { pending: true, notice: "已把这次「write_file」交给用户确认（当前档位：按需确认），**还没有执行**。" },
      }),
      rec("r1", "done"),
    ];
    const view = recoveryViewOf(records);
    expect(view.interrupted, "这一轮其实收尾了").toEqual([]);
    expect(view.pending.length).toBe(1);
    expect(view.pending[0]!.name).toBe("write_file");
    expect(view.needsAttention).toBe(true);
  });

  it("⑥ 干净的一段会话：什么都不提示（别每次启动都吓用户一跳）", () => {
    const records = [request("r1", "你好"), rec("r1", "text", { text: "在" }), rec("r1", "done")];
    const view = recoveryViewOf(records);
    expect(view.needsAttention).toBe(false);
    expect(view.interrupted).toEqual([]);
    expect(view.pending).toEqual([]);
  });

  it("⑦ 空记录：不崩、不提示", () => {
    expect(recoveryViewOf([])).toEqual({ interrupted: [], pending: [], needsAttention: false });
  });

  it("⑧ 没有 request 记录的那种截断（日志被削过头）：不误报成一整轮", () => {
    // 只有一条孤立的 text（没有 request）—— 认不出"是哪一轮"，所以不该报
    const orphan = [rec("r-x", "text", { text: "孤儿记录" })];
    expect(interruptedTurns(orphan)).toEqual([]);
  });
});

/** 这条只是防止上面 `chatSessionId` 的导入被 lint 判成没用（会话 id 的形状由它保证）。 */
describe("会话 id（顺带钉一下依赖）", () => {
  it("chat 前缀", () => {
    expect(chatSessionId("x")).toBe("chat-x");
  });
});

/* ============================================================
 * U09：四类恢复（2026-10-18）
 *
 * 判据是"重开之后用户能看见什么、能做什么"：
 * ① 会话本身可恢复；② 待批可继续；③ 工具结果已在（不用重跑）；
 * ④ 调用了一半的工具**有留痕写着"结果未知"**（不是凭空消失）。
 * ============================================================ */
describe("U09：四类恢复", () => {
  const T = (n: number) => 1_700_000_000_000 + n * 1000;
  const base = [
    { seq: 1, at: T(1), requestId: "r1", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "帮我改个文件" }] },
    { seq: 2, at: T(2), requestId: "r1", type: "tool-call", toolCallId: "c1", toolName: "edit_file", input: { path: "a.ts", oldText: "1", newText: "2" } },
    { seq: 3, at: T(3), requestId: "r1", type: "tool-result", toolCallId: "c1", toolName: "edit_file", output: { ok: true, line: "改了「a.ts」" } },
    { seq: 4, at: T(4), requestId: "r1", type: "text", text: "改好了" },
    { seq: 5, at: T(5), requestId: "r1", type: "done" },
  ] as never[];

  it("① 会话可恢复：轮次与正文都在", () => {
    const resumed = resumeSession(base as never);
    expect(resumed.turns).toHaveLength(1);
    expect(resumed.turns[0]?.view.text).toBe("改好了");
  });

  it("③ 工具结果已在：留痕是成功，不是「未知」", () => {
    const traces = resumeSession(base as never).turns[0]?.view.traces ?? [];
    expect(traces).toHaveLength(1);
    expect(traces[0]?.toolCallId).toBe("c1");
    expect(traces[0]?.ok).toBe(true);
    expect(traces[0]?.line).not.toContain("结果未知");
  });

  it("⭐ ④ 调用了一半（没有 tool-result）→ 留痕写明「结果未知」", () => {
    const killed = [
      { seq: 1, at: T(1), requestId: "r1", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "写文件" }] },
      { seq: 2, at: T(2), requestId: "r1", type: "tool-call", toolCallId: "c9", toolName: "write_file", input: { path: "a.md", content: "x" } },
    ] as never[];
    const traces = resumeSession(killed as never).turns[0]?.view.traces ?? [];
    expect(traces).toHaveLength(1);
    expect(traces[0]?.toolCallId).toBe("c9");
    expect(traces[0]?.line).toContain("结果未知");
    /* 参数还在（否则用户连"它当时想写什么"都看不到） */
    expect(traces[0]?.input).toEqual({ path: "a.md", content: "x" });
  });

  it("② 待批可继续：pending 名单 + 运行态都在", () => {
    const waiting = [
      ...base.slice(0, 2),
      { seq: 3, at: T(3), requestId: "r1", type: "tool-result", toolCallId: "c1", toolName: "edit_file", output: { pending: true, notice: "等你确认" } },
      { seq: 4, at: T(4), requestId: "r1", type: "done" },
      { seq: 5, at: T(5), type: "run-state", state: "waiting_for_confirmation", pending: [{ toolCallId: "c1", name: "edit_file", since: T(3) }] },
    ] as never[];
    const resumed = resumeSession(waiting as never);
    expect(resumed.pending.map((p) => p.toolCallId)).toEqual(["c1"]);
    expect(resumed.runState?.state).toBe("waiting_for_confirmation");
    expect(resumed.turns[0]?.view.traces[0]?.pending).toBe(true);
  });
});
