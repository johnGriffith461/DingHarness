import { describe, expect, it } from "vitest";
import type { AiStreamEvent } from "@shared/ipc";
import {
  applyEvent,
  emptyTurn,
  finishTurn,
  isPendingOutput,
  logLine,
  parseLog,
  projectTurn,
} from "@shared/sessionLog";

/**
 * C2：会话事件的投影（**一份实现，两条路径共用**）。
 *
 * ## 为什么这些断言必须存在
 *
 * 这段"事件 → 留痕/正文/用量"的推导原来被写了**四遍**（工作台、聊天、悬浮助手、
 * 主进程），于是它们慢慢答得不一样：实测工作台**不接 usage**（`done` 事件被丢掉）、
 * 聊天**不展开**子智能体上交的调用。收敛成一份之后，**这一份必须被钉住** ——
 * 否则下一次"再抄一份"就又把答案分裂开。
 *
 * ⚠️ 断言的是**能证伪的行为**（参数有没有配上、pending 判对没有、坏行会不会拖倒整段），
 * 不是"函数被调过"。
 */

const T = (n: number) => 1_700_000_000_000 + n;

/**
 * 事件的输入形状（还没带 requestId）。
 *
 * ⚠️ 不能写成 `Omit<AiStreamEvent, "requestId">`：`Omit` 作用在**联合类型**上
 * 只会留下各成员的公共字段，于是 `text` / `toolCallId` 全被抹掉，
 * 传什么都报属性不存在。所以显式展开一遍联合（与 `shared/sessionLog.ts` 的 `LogInput` 同一个道理）。
 */
type EvInput = AiStreamEvent extends infer U ? (U extends AiStreamEvent ? Omit<U, "requestId"> : never) : never;

/** 造一条事件（省掉每个用例重复写 requestId）。 */
const ev = (e: EvInput): AiStreamEvent => ({ requestId: "r1", ...e } as AiStreamEvent);

describe("applyEvent · 正文与收尾", () => {
  it("文本按到达顺序累积；done 之前不算结束", () => {
    let state = emptyTurn();
    expect(state.done).toBe(false);
    state = applyEvent(state, ev({ type: "text", text: "你" }));
    state = applyEvent(state, ev({ type: "text", text: "好" }));
    expect(state.text).toBe("你好");
    expect(state.done).toBe(false);

    state = applyEvent(state, ev({ type: "done" }));
    expect(finishTurn(state).done).toBe(true);
  });

  it("done 带 usage 就接住（**拿不到就不编**：没有就是 undefined）", () => {
    const withUsage = projectTurn([ev({ type: "done", usage: { inputTokens: 10, outputTokens: 3 } })]);
    expect(withUsage.usage).toEqual({ inputTokens: 10, outputTokens: 3 });

    expect(projectTurn([ev({ type: "done" })]).usage).toBeUndefined();
  });

  it("error 记下来并算结束（界面据此收尾，不必再等 done）", () => {
    const view = projectTurn([ev({ type: "text", text: "半" }), ev({ type: "error", message: "已中止" })]);
    expect(view.error).toBe("已中止");
    expect(view.done).toBe(true);
    // 已经出来的半句话不丢 —— 用户看得见"说到哪儿断的"
    expect(view.text).toBe("半");
  });
});

describe("applyEvent · 工具调用（参数配对 + pending）", () => {
  it("⭐ 参数按 toolCallId 配上，留痕那一行由 describeToolResult 生成", () => {
    const view = projectTurn([
      ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: { text: "主人喜欢美式" } }),
      ev({ type: "tool-result", toolCallId: "c1", toolName: "memory_save", output: { count: 3 } }),
    ]);
    expect(view.traces).toHaveLength(1);
    expect(view.traces[0].input).toEqual({ text: "主人喜欢美式" });
    expect(view.traces[0].line).toContain("已保存");
    // 参数摘要挂在那一行末尾（§175 的口径）
    expect(view.traces[0].line).toContain("主人喜欢美式");
    expect(view.traces[0].pending).toBeUndefined();
  });

  it("⭐⭐ 被闸门拦下的那一条：`pending:true` 保留，且**没有输出**（它没执行）", () => {
    const output = { pending: true, notice: "这一步需要你确认" };
    const view = projectTurn([
      ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: { text: "x" } }),
      ev({ type: "tool-result", toolCallId: "c1", toolName: "memory_save", output }),
    ]);
    expect(view.traces[0].pending).toBe(true);
    expect(view.traces[0].line).toContain("等你确认");
    expect(view.traces[0].line).toContain("还没执行");
  });

  it("⚠️ 判 pending 只认 `=== true`（别的形状一律当已执行，不能凭空给「允许」按钮）", () => {
    expect(isPendingOutput({ pending: true })).toBe(true);
    // 这些都不算：字符串 "true"、1、字段名不同
    expect(isPendingOutput({ pending: "true" })).toBe(false);
    expect(isPendingOutput({ pending: 1 })).toBe(false);
    expect(isPendingOutput({ pendingApproval: true })).toBe(false);
    expect(isPendingOutput(undefined)).toBe(false);
    expect(isPendingOutput(null)).toBe(false);
    // 工具真返回的业务数据里恰好有 pending 字段时…只有 true 才算（其余形状由各工具自己保证）
    expect(isPendingOutput({ ok: true })).toBe(false);
  });

  it("⭐ 只有调用、没有结果的那半截**不进**留痕（「发生过的事」不该有半截）", () => {
    const state = applyEvent(
      emptyTurn(),
      ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: { text: "x" } }),
    );
    expect(finishTurn(state).traces).toEqual([]);
  });

  it("工具失败也是一条留痕（错误当结果回注，别让它消失）", () => {
    const view = projectTurn([
      ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: {} }),
      ev({ type: "tool-result", toolCallId: "c1", toolName: "memory_save", error: "磁盘满了" }),
    ]);
    expect(view.traces[0].ok).toBe(false);
    expect(view.traces[0].error).toBe("磁盘满了");
  });

  it("⭐ 同一条调用的事件重复到达时，留痕按 toolCallId **幂等替换**（日志追加写会重试，重放不能多出一行）", () => {
    const view = projectTurn([
      ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_list", input: {} }),
      ev({ type: "tool-result", toolCallId: "c1", toolName: "memory_list", output: { count: 2 } }),
      // 追加写重试造成的重复
      ev({ type: "tool-result", toolCallId: "c1", toolName: "memory_list", output: { count: 2 } }),
    ]);
    expect(view.traces).toHaveLength(1);
    expect(view.traces[0].toolCallId).toBe("c1");
  });

  it("一条回复里的**多次**调用各自留痕（按 id 分辨，不能按工具名）", () => {
    const view = projectTurn([
      ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: { text: "一" } }),
      ev({ type: "tool-result", toolCallId: "c1", toolName: "memory_save", output: { count: 1 } }),
      ev({ type: "tool-call", toolCallId: "c2", toolName: "memory_save", input: { text: "二" } }),
      ev({ type: "tool-result", toolCallId: "c2", toolName: "memory_save", output: { count: 2 } }),
    ]);
    expect(view.traces.map((t) => t.toolCallId)).toEqual(["c1", "c2"]);
    expect(view.traces.map((t) => (t.input as { text: string }).text)).toEqual(["一", "二"]);
  });
});

describe("子智能体上交的调用（§176）", () => {
  const events: AiStreamEvent[] = [
    ev({ type: "tool-call", toolCallId: "s1", toolName: "spawn_agent", input: { task: "查一下" } }),
    ev({
      type: "tool-result",
      toolCallId: "s1",
      toolName: "spawn_agent",
      output: {
        ok: true,
        summary: "查完了",
        steps: 2,
        toolCalls: ["memory_save"],
        blocked: [{ toolCallId: "b1", name: "memory_save", input: { text: "它想存的" } }],
      },
    }),
  ];

  it("开 expandBlocked：上交的那条变成**父级上的待批准项**（带参数，才能原样执行）", () => {
    const view = projectTurn(events, { expandBlocked: true });
    expect(view.traces).toHaveLength(2);
    expect(view.traces[1].pending).toBe(true);
    expect(view.traces[1].name).toBe("memory_save");
    expect(view.traces[1].input).toEqual({ text: "它想存的" });
    // 顺序：先那条"子智能体完成了"，再挂上交的待批准项
    expect(view.traces[0].name).toBe("spawn_agent");
  });

  it("关 expandBlocked（聊天侧的现状）：只留子智能体那一条，不额外造按钮", () => {
    expect(projectTurn(events).traces).toHaveLength(1);
  });

  it("⚠️ 工具这一层**报错**时才是「没跑成」：那种情况下它连 report 都没有，自然没有可展开的东西", () => {
    const errored = [
      events[0],
      ev({ type: "tool-result", toolCallId: "s1", toolName: "spawn_agent", error: "拿不到 provider" }),
    ];
    const view = projectTurn(errored, { expandBlocked: true });
    expect(view.traces).toHaveLength(1);
    expect(view.traces[0].ok).toBe(false);
  });

  it("报告自身 ok:false 但**闸门真拦下过东西**时照旧展开（这是原工作台的行为，用户该看到它想做什么）", () => {
    const failed = [
      events[0],
      ev({
        type: "tool-result",
        toolCallId: "s1",
        toolName: "spawn_agent",
        output: { ok: false, blocked: [{ toolCallId: "b1", name: "memory_save", input: { text: "它想存的" } }] },
      }),
    ];
    const view = projectTurn(failed, { expandBlocked: true });
    expect(view.traces).toHaveLength(2);
    expect(view.traces[1].pending).toBe(true);
  });
});

describe("INV-2：流式与投影走的是同一条路", () => {
  it("逐条 applyEvent 的结果 = 一次性 projectTurn（否则「边流边显示」与「事后重建」会不一致）", () => {
    const events: AiStreamEvent[] = [
      ev({ type: "text", text: "先查" }),
      ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_list", input: {} }),
      ev({ type: "tool-result", toolCallId: "c1", toolName: "memory_list", output: { count: 2 } }),
      ev({ type: "text", text: "，共 2 条" }),
      ev({ type: "done", usage: { inputTokens: 5, outputTokens: 7 } }),
    ];

    let streamed = emptyTurn();
    for (const event of events) streamed = applyEvent(streamed, event);

    expect(finishTurn(streamed)).toEqual(projectTurn(events));
  });

  it("任何时刻看留痕都是「可显示的」（没有空行：半截调用不会漏出去）", () => {
    let state = emptyTurn();
    const seen: string[] = [];
    for (const event of [
      ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: { text: "x" } }),
      ev({ type: "tool-result", toolCallId: "c1", toolName: "memory_save", output: { count: 1 } }),
    ]) {
      state = applyEvent(state, event);
      for (const t of finishTurn(state).traces) seen.push(t.line);
    }
    expect(seen.every((line) => line.length > 0)).toBe(true);
    expect(seen).toHaveLength(1);
  });
});

describe("日志行（jsonl）", () => {
  it("序列化 → 解析：往返一致（含 seq/at）", () => {
    const line = logLine(ev({ type: "text", text: "你好" }), 3, T(3));
    expect(line.endsWith("\n")).toBe(true);
    const { records, skipped } = parseLog(line);
    expect(skipped).toBe(0);
    expect(records).toEqual([{ requestId: "r1", type: "text", text: "你好", seq: 3, at: T(3) }]);
  });

  it("⭐ 坏行只跳过它自己（断电/强杀留下的半行不许让整段历史消失）", () => {
    const text = [
      logLine(ev({ type: "text", text: "一" }), 1, T(1)),
      '{"seq":2,"at":1700000000002,"requestId":"r1","ty', // 写到一半断了
      "不是 json",
      logLine(ev({ type: "done" }), 3, T(3)),
    ].join("\n");
    const { records, skipped } = parseLog(text);
    expect(records.map((e) => e.seq)).toEqual([1, 3]);
    expect(skipped).toBe(2);
  });

  it("缺 seq/at、类型不认识的行都算坏行（宁可跳过，不要拿半个事件去投影）", () => {
    const text = [
      '{"requestId":"r1","type":"text","text":"没有 seq"}',
      '{"seq":1,"requestId":"r1","type":"text","text":"没有 at"}',
      '{"seq":1,"at":1,"requestId":"r1","type":"未来才有的事件"}',
      '{"seq":1,"at":1,"requestId":"r1","type":"done"}',
    ].join("\n");
    const { records, skipped } = parseLog(text);
    expect(records).toHaveLength(1);
    expect(skipped).toBe(3);
  });

  it("乱序落盘时按 seq 归位（追加写的日志不怕这个，但读的人不该受影响）", () => {
    const text = [logLine(ev({ type: "text", text: "后" }), 2, T(2)), logLine(ev({ type: "text", text: "前" }), 1, T(1))].join("\n");
    const { records } = parseLog(text);
    expect(records.map((e) => (e as { text: string }).text)).toEqual(["前", "后"]);
    // 归位之后投影出来才是对的顺序
    expect(projectTurn(records).text).toBe("前后");
  });
});
