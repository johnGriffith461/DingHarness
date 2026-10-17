import { describe, expect, it } from "vitest";

import { parseLog, parseLogLine } from "./events";
import {
  PENDING_TTL_MS,
  RUN_STATES,
  canTransition,
  endStateOf,
  foldRunState,
  normalizeRunStateRecord,
  type RunState,
} from "./runState";

/**
 * 运行状态机（U01）。
 *
 * 这组断言挡四件事：
 * ① 迁移表（哪些合法、哪些非法）—— 非法迁移不许静默发生；
 * ② `waiting_for_confirmation` 必须带 pending 明细，且已批的要被扣掉；
 * ③ 冷启动把 `running` 判成 `error`（进程没了），但**不判死** `paused`/`waiting`；
 * ④ 记录能被日志解析器读回来（旧日志零迁移、坏形状被拒）。
 */

const rec = (state: RunState, extra: Record<string, unknown> = {}) => ({
  seq: 1,
  at: 1_000,
  type: "run-state" as const,
  state,
  ...extra,
});

describe("迁移表（canTransition）", () => {
  it("合法：开跑 / 等确认 / 暂停 / 收尾", () => {
    expect(canTransition("idle", "running")).toBe(true);
    expect(canTransition("running", "waiting_for_confirmation")).toBe(true);
    expect(canTransition("waiting_for_confirmation", "running")).toBe(true);
    expect(canTransition("paused", "running")).toBe(true);
    expect(canTransition("running", "finished")).toBe(true);
    expect(canTransition("running", "error")).toBe(true);
    expect(canTransition("running", "stuck")).toBe(true);
  });

  it("⭐ 非法：不许从 idle 直接 finished、不许从 finished 直接 running 之外乱跳", () => {
    expect(canTransition("idle", "finished")).toBe(false);
    expect(canTransition("idle", "waiting_for_confirmation")).toBe(false);
    expect(canTransition("finished", "finished")).toBe(false);
    expect(canTransition("error", "paused")).toBe(false);
    expect(canTransition("waiting_for_confirmation", "finished")).toBe(false);
  });

  it("看完就去：每个状态至少有一条出路（没有死胡同）", () => {
    for (const state of RUN_STATES) {
      if (state === "idle") continue;
      const outs = RUN_STATES.filter((to) => canTransition(state, to));
      expect(outs.length, `${state} 没有任何出路`).toBeGreaterThan(0);
    }
  });
});

describe("收尾状态（endStateOf）", () => {
  it("有待确认 → waiting（即使这一轮 ok）", () => {
    expect(endStateOf({ ok: true, pending: 1 }).state).toBe("waiting_for_confirmation");
  });

  it("中止 → error + 原因；普通成功 → finished", () => {
    expect(endStateOf({ ok: false, aborted: true, pending: 0 })).toEqual({ state: "error", reason: "已中止" });
    expect(endStateOf({ ok: true, pending: 0 }).state).toBe("finished");
    expect(endStateOf({ ok: false, pending: 0 })).toEqual({ state: "error", reason: "这一轮以错误收尾" });
  });
});

describe("回放（foldRunState）", () => {
  it("空日志 = idle（旧日志零迁移）", () => {
    expect(foldRunState([]).state).toBe("idle");
  });

  it("最后一条状态记录说了算", () => {
    const got = foldRunState([rec("running"), { ...rec("finished"), seq: 2 }]);
    expect(got.state).toBe("finished");
  });

  it("⭐ 冷启动把 running 判成 error（进程已经没了），并给出恢复说明", () => {
    const got = foldRunState([rec("running")], { coldStart: true });
    expect(got.state).toBe("error");
    expect(got.recovered).toBe("running");
    expect(got.reason).toContain("继续");
  });

  it("⭐ 冷启动**不**判死 waiting / paused（它们是用户可继续的状态）", () => {
    expect(foldRunState([rec("waiting_for_confirmation")], { coldStart: true }).state).toBe(
      "waiting_for_confirmation",
    );
    expect(foldRunState([rec("paused")], { coldStart: true }).state).toBe("paused");
  });

  it("⭐ pending 明细保留；已有审批决策的调用被扣掉", () => {
    const pending = [
      { toolCallId: "c1", name: "write_file", summary: "「a.md」", since: 1_000, expiresAt: 1_000 + PENDING_TTL_MS },
      { toolCallId: "c2", name: "run_command", since: 1_000 },
    ];
    const waiting = rec("waiting_for_confirmation", { pending });
    const afterOne = foldRunState([waiting, { seq: 2, at: 2_000, type: "approval", toolCallId: "c1" }]);
    expect(afterOne.state).toBe("waiting_for_confirmation");
    expect(afterOne.pending.map((p) => p.toolCallId)).toEqual(["c2"]);
  });

  it("全部批完 → paused（还报「等你确认」会骗人）", () => {
    const waiting = rec("waiting_for_confirmation", {
      pending: [{ toolCallId: "c1", name: "write_file", since: 1_000 }],
    });
    const got = foldRunState([waiting, { seq: 2, at: 2_000, type: "approval", toolCallId: "c1" }]);
    expect(got.state).toBe("paused");
    expect(got.reason).toContain("等待继续");
  });
});

describe("记录形状（normalizeRunStateRecord / parseLogLine）", () => {
  it("缺 seq/at 或状态词不认识 → 拒（不是猜一个默认值）", () => {
    expect(normalizeRunStateRecord({ type: "run-state", state: "running", seq: 1 })).toBeNull();
    expect(normalizeRunStateRecord({ type: "run-state", state: "flying", seq: 1, at: 2 })).toBeNull();
    expect(normalizeRunStateRecord({ type: "run-state", state: "running", seq: 1, at: 2 })?.state).toBe("running");
  });

  it("坏 pending 条目被丢掉，好的保留（磁盘不可信）", () => {
    const got = normalizeRunStateRecord({
      type: "run-state",
      state: "waiting_for_confirmation",
      seq: 1,
      at: 2,
      pending: [{ toolCallId: "ok", name: "read_file", since: 3 }, { toolCallId: 42, name: "x" }, null],
    });
    expect(got?.pending?.map((p) => p.toolCallId)).toEqual(["ok"]);
  });

  it("⭐ 日志解析器认得它（否则重开时会被算成坏行）", () => {
    const line = JSON.stringify({ seq: 7, at: 1_700_000_000_000, type: "run-state", state: "finished" });
    const parsed = parseLogLine(line);
    expect(parsed?.type).toBe("run-state");
    const log = parseLog([line, JSON.stringify({ seq: 8, at: 1, type: "run-state", state: "nope" })].join("\n"));
    expect(log.records).toHaveLength(1);
    expect(log.skipped).toBe(1);
  });
});
