import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isTerminalRecord, interruptedFromStage, recoveryViewOf, TERMINAL_RECORD_TYPES } from "@engine/core/recovery";
import type { LogRecord } from "@engine/core/events";
import { INTERRUPTED_NOTE, continueTargetOf } from "./task";
import { normalizeTask } from "./taskPersist";

const ROOT = path.resolve(__dirname, "..", "..");

/**
 * 桌面端「继续」的判据与引擎侧**是同一个**（审计 P139 / P211）。
 *
 * ## 这条守卫挡的是什么
 *
 * 「这一轮被打断了吗」原来在两边各写了一遍：
 *   · 引擎侧：日志里这一轮的请求**有没有终止记录**（`recovery.ts` 的 `interruptedTurns`）；
 *   · 桌面侧：`activity` 里**有没有「被中断」三个字**（`task.ts` 的字符串匹配）。
 *
 * 两份口径漂移的代价很具体：provider 报一句「连接被中断」（说的是网络断了）
 * 也会长出一颗「继续」按钮，点下去**又花一次钱**；反过来，真被打断的那一轮
 * 只要说明换了个说法，按钮就消失了。
 *
 * 现在判据只有一条（`engine/core/recovery.ts`）：桌面端恢复时用它算出真值
 * `task.interrupted` 落盘，界面只读那个真值。下面**逐个场景让两侧对答案** ——
 * 只要有一侧改了口径（比如把 `awaiting` 也算成被打断），这一组就红。
 */

let seq = 0;
function record(type: string, extra: Record<string, unknown> = {}): LogRecord {
  seq += 1;
  return { seq, at: 1_700_000_000_000 + seq, requestId: "r1", type, ...extra } as unknown as LogRecord;
}

/** 一条请求记录（会话的「一轮开始」）。 */
function request(text: string): LogRecord {
  seq += 1;
  return {
    seq,
    at: 1_700_000_000_000 + seq,
    requestId: "r1",
    type: "request",
    provider: "deepseek",
    model: "deepseek-chat",
    messages: [{ role: "user", content: text }],
  } as unknown as LogRecord;
}

/** 落盘的（不可信的）任务形状 —— 就是 `tasks.json` 里那一条。 */
const diskTask = (patch: Record<string, unknown> = {}) => ({
  id: "t1",
  title: "整理纪要",
  brief: "把 demo 里的 md 整理成纪要",
  createdAt: 1_700_000_000_000,
  stage: "running",
  startedAt: 1_700_000_000_000,
  finishedAt: null,
  steps: [
    { id: "s1", role: "user", text: "把 demo 里的 md 整理成纪要", at: 1_700_000_000_000 },
    { id: "s2", role: "assistant", text: "我看到两个文件，其中", at: 1_700_000_000_100 },
  ],
  questions: [],
  questionIndex: 0,
  activity: "正在处理",
  artifacts: [],
  ...patch,
});

describe("判据只此一处：引擎侧的词表与函数", () => {
  it("终止记录就 `done` / `error` 两类（加第三类时要改的只有那张表）", () => {
    expect([...TERMINAL_RECORD_TYPES]).toEqual(["done", "error"]);
    expect(isTerminalRecord({ type: "done" })).toBe(true);
    expect(isTerminalRecord({ type: "error" })).toBe(true);
    /* 流事件不是收尾；坏数据（连 type 都没有）也照样答 false，不抛 */
    expect(isTerminalRecord({ type: "text" })).toBe(false);
    expect(isTerminalRecord({})).toBe(false);
    expect(isTerminalRecord({ type: 42 })).toBe(false);
  });

  it("⭐ 收尾与否的判据：只有 `running` 是「没有收尾」，`awaiting` 是在等人（不算被打断）", () => {
    expect(interruptedFromStage("running"), "上次关窗口时真在跑的那一轮").toBe(true);
    expect(interruptedFromStage("awaiting"), "等用户回答的那一轮没有收尾记录，但它不是被打断").toBe(false);
    expect(interruptedFromStage("done")).toBe(false);
    expect(interruptedFromStage("failed")).toBe(false);
    /* 磁盘上的东西不可信：认不出来的值一律当「没被打断」（不给按钮比给错按钮好） */
    expect(interruptedFromStage(undefined)).toBe(false);
    expect(interruptedFromStage("RUNNING")).toBe(false);
    expect(interruptedFromStage(7)).toBe(false);
  });
});

describe("⭐ 两侧对答案：引擎怎么判，桌面就怎么给按钮", () => {
  /** 进程被杀：请求在、没有终止记录。 */
  const killed: LogRecord[] = [request("把 demo 里的 md 整理成纪要"), record("tool-call", { toolCallId: "c1", toolName: "list_dir" })];
  /** 用户点了停止：`error` 里写着「已中止」—— 那是**收尾**（不是被打断）。 */
  const stopped: LogRecord[] = [request("把 demo 里的 md 整理成纪要"), record("error", { message: "已中止" })];
  /** 正常跑完。 */
  const finished: LogRecord[] = [request("把 demo 里的 md 整理成纪要"), record("done", { usage: { inputTokens: 10 } })];

  it("① 进程被杀：引擎说「有被打断的回合」，桌面给得出那句原话", () => {
    const view = recoveryViewOf(killed);
    expect(view.interrupted.map((t) => t.userMessage)).toEqual(["把 demo 里的 md 整理成纪要"]);
    expect(view.needsAttention).toBe(true);

    const restored = normalizeTask(diskTask());
    expect(restored?.stage, "恢复时仍在跑的任务要判死（没人接着跑）").toBe("failed");
    expect(restored?.interrupted).toBe(true);
    expect(continueTargetOf(restored!), "引擎说有被打断的回合，桌面却不肯给按钮").toBe("把 demo 里的 md 整理成纪要");
  });

  it("② 用户自己停的：引擎说「没有被打断的回合」，桌面不给按钮", () => {
    expect(recoveryViewOf(stopped).interrupted).toEqual([]);

    const restored = normalizeTask(diskTask({ stage: "failed", activity: "已停止" }));
    expect(restored?.interrupted, "没被打断过的失败任务身上不该多出那个真值").toBeUndefined();
    expect(continueTargetOf(restored!)).toBeNull();
  });

  it("③ 正常跑完：两侧都无事可做", () => {
    expect(recoveryViewOf(finished).needsAttention).toBe(false);
    const restored = normalizeTask(diskTask({ stage: "done", activity: "已完成" }));
    expect(restored?.stage).toBe("done");
    expect(continueTargetOf(restored!)).toBeNull();
  });

  it("⭐ 在等人的那一轮：引擎报「有待决审批」，桌面**不给继续按钮**（该做的是回答那张卡）", () => {
    /* 一张被闸门拦下的卡：`tool-result` 里 `{pending:true}` —— 与 `gates.ts` 的口径同一份 */
    const awaitingLog: LogRecord[] = [
      request("把 demo 里的 md 整理成纪要"),
      record("tool-call", { toolCallId: "t1", toolName: "write_file", input: { path: "a.md", content: "x" } }),
      record("tool-result", {
        toolCallId: "t1",
        toolName: "write_file",
        output: { pending: true, notice: "等确认" },
      }),
    ];
    const view = recoveryViewOf(awaitingLog);
    expect(view.pending.length).toBe(1);
    expect(view.needsAttention).toBe(true);
    /*
     * ⚠️ 引擎那个 `interrupted` 说的是**未收尾**，它把这一轮也算进去（它确实没有 `done`）。
     * 但「该重发」不是同一个问题：这一轮停在闸门上，要等的是**决定** —— 那一格是 `pending`。
     * 这条区别就是 `engine/core/recovery.ts` 的 `interruptedFromStage` 里那个例外，
     * 桌面端只认 `running`，所以下面不会给按钮。
     */
    expect(view.interrupted.length, "引擎侧它仍未收尾（该有的动作由 `pending` 那一栏给出）").toBe(1);

    const restored = normalizeTask(diskTask({ stage: "awaiting", activity: "正在询问用户" }));
    expect(restored?.stage, "在等人的任务不该被系统自己判死").toBe("awaiting");
    expect(restored?.interrupted).toBeUndefined();
    expect(continueTargetOf(restored!), "在等人的任务给了继续按钮：用户该做的是回答那张卡").toBeNull();
  });
});

describe("判据不散回桌面层（P139 / P211）", () => {
  it("⭐ 恢复时「算不算被打断」走引擎的判据，不是这里手写 `stage === running`", () => {
    const src = readFileSync(path.join(ROOT, "src", "workbench", "taskPersist.ts"), "utf8");
    expect(
      src,
      "判据又内联回桌面层了 —— 那样它就会与引擎那一份各漂各的（这正是 P139/P211 报的）",
    ).toContain("interruptedFromStage(");
  });
});

describe("说明不是判据（这次修复挡的那个假按钮）", () => {
  it("⭐ 说明里带「被中断」但不是那回事（provider 报的连接断了）→ 不给按钮", () => {
    const restored = normalizeTask(
      diskTask({ stage: "failed", activity: "连不上 provider：连接被中断，重试一下" }),
    );
    expect(
      continueTargetOf(restored!),
      "按说明做字符串匹配 → 网络报错也长出一颗「继续」按钮，点下去又花一次钱",
    ).toBeNull();
  });

  it("真被打断过：真值比说明硬（说明被别处改写了也照样给按钮）", () => {
    expect(continueTargetOf({ ...diskTask(), stage: "failed", interrupted: true, activity: "" })).toBe(
      "把 demo 里的 md 整理成纪要",
    );
  });

  it("旧盘（这次修复之前写下的 tasks.json）没有真值字段：只能按那句说明认一次", () => {
    /* 这句说明是那时唯一的痕迹 —— 如实认它，但不扩散到新数据 */
    expect(continueTargetOf({ ...diskTask(), stage: "failed", activity: INTERRUPTED_NOTE })).toBe(
      "把 demo 里的 md 整理成纪要",
    );
    expect(continueTargetOf({ ...diskTask(), stage: "failed", activity: "已停止" })).toBeNull();
  });
});
