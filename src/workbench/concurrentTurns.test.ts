import { beforeEach, describe, expect, it } from "vitest";
import { abortRunning, runStream } from "./taskRuntime";
import type { StorePort, WorkbenchState } from "./store";

/**
 * 同一会话并发跑两轮（2026-10-16 审计 P46）。
 *
 * ## 缺陷形状
 *
 * `activeHandle` 原来是一个**模块级单值**：
 *
 * ```ts
 * let activeHandle: { abort: () => void } | null = null;
 * ...
 * activeHandle = handle;   // 第二条流一注册就把第一条顶掉
 * await handle.done;
 * activeHandle = null;     // 而且第一条收尾会把还在跑的那条的状态抹掉
 * ```
 *
 * 触发路径是**活的**（不是理论）：`Composer` 的 Enter 分支不看 `running`、
 * `HomeView` 那颗按钮也不 disable —— 同一段对话连点两下就是两轮并发。后果两条：
 *   ① 点「停止」停的是**后开的那条**（用户想停的可能是他正在看的那条）；
 *   ② 先收尾的那一轮把 `runningRequestId` 清成 null，界面上"正在回复"消失而请求还在飞。
 *
 * 判据：**两条流各自可停、且"在跑"这个标志按真实剩余轮数算**。
 */

/** 一条假的主进程 AI 通道：能按 requestId 推事件、能记录被中止的是谁。 */
function fakeBridge() {
  const handlers: Array<(raw: unknown) => void> = [];
  const aborted: string[] = [];
  let started = 0;
  const bridge = {
    ai: {
      chat: async () => {
        started += 1;
        return { ok: true, requestId: `r${started}` };
      },
      abort: async (requestId: string) => {
        aborted.push(requestId);
      },
      onStream: (handler: (raw: unknown) => void) => {
        handlers.push(handler);
        return () => {
          const at = handlers.indexOf(handler);
          if (at >= 0) handlers.splice(at, 1);
        };
      },
      listProviders: async () => [{ id: "strata", label: "S", models: ["m"], available: true, keyRef: "" }],
      fetchModels: async () => ({ ok: true, models: [] }),
      probe: async () => [],
    },
  };
  return {
    bridge,
    aborted,
    /** 给某一轮推一条事件。 */
    push: (requestId: string, event: Record<string, unknown>) => {
      for (const handler of [...handlers]) handler({ requestId, ...event });
    },
    /** 结束某一轮（真实流就是这么收的）。 */
    finish: (requestId: string) => {
      for (const handler of [...handlers]) handler({ requestId, type: "done" });
    },
  };
}

/** 最小 StorePort：只要 `getState` / `setState`（`runStream` 不用 subscribe）。 */
function makePort(initial: Partial<WorkbenchState>): { port: StorePort; read: () => Partial<WorkbenchState> } {
  let state = { tasks: [], runningRequestId: null, ...initial } as unknown as WorkbenchState;
  const port = {
    getState: () => state,
    setState: (partial: unknown) => {
      const patch = typeof partial === "function" ? (partial as (s: unknown) => unknown)(state) : partial;
      state = { ...state, ...(patch as object) } as WorkbenchState;
    },
    subscribe: () => () => undefined,
  } as unknown as StorePort;
  return { port, read: () => state as unknown as Partial<WorkbenchState> };
}

/** 让异步链跑起来（`runStream` 里有动态 import 与几次 await，光 await Promise 不够）。 */
async function settle(get: () => unknown, label: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (get()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`夹具没跑起来：${label} 一直是空的`);
}

let fake = fakeBridge();

beforeEach(() => {
  fake = fakeBridge();
  (globalThis as unknown as { shell?: unknown }).shell = fake.bridge;
});

describe("P46：两轮并发时句柄按轮次持有", () => {
  it("⭐ 两段对话各跑一轮：先收尾的那一轮不许把另一轮的标志抹掉", async () => {
    /*
     * 用**同一个 port**（应用里只有一个工作台 store，模块级的句柄表也是全局一份 ——
     * 这正是当初一个单值句柄就够用、也正是它会互相顶掉的原因）。
     * 两轮分属两段对话（会话不同），这是"新任务 + 旧任务同时在跑"的形状。
     */
    const shared = makePort({});
    const turnA = runStream(shared.port, "第一句", "系统", () => undefined, [], "task-a");
    await settle(() => shared.read().runningRequestId, "第一条流");
    const idA = String(shared.read().runningRequestId);
    const turnB = runStream(shared.port, "第二句", "系统", () => undefined, [], "task-b");
    await settle(() => shared.read().runningRequestId && String(shared.read().runningRequestId) !== idA, "第二条流");
    const idB = String(shared.read().runningRequestId);
    expect(idB).not.toBe(idA);

    fake.finish(idA);
    await turnA;
    expect(
      shared.read().runningRequestId,
      "第一轮收尾后台上还在跑第二轮，标志却被清成 null（界面上「正在回复」消失而请求还在飞）",
    ).toBe(idB);

    fake.finish(idB);
    await turnB;
    expect(shared.read().runningRequestId, "都收尾了才该是 null").toBeNull();
  });

  it("⭐ 同一段对话并发两轮：句柄不互相顶掉（这是 P46 的原形）", async () => {
    const shared = makePort({});
    const first = runStream(shared.port, "先发的", "系统", () => undefined, [], "task-1");
    await settle(() => shared.read().runningRequestId, "第一轮");
    const firstId = String(shared.read().runningRequestId);
    const second = runStream(shared.port, "后发的", "系统", () => undefined, [], "task-1");
    await settle(() => shared.read().runningRequestId && String(shared.read().runningRequestId) !== firstId, "第二轮");

    fake.finish(firstId);
    await first;
    expect(
      shared.read().runningRequestId,
      "第一轮收尾把**还在跑的第二轮**标志清成 null 了（P46 的第二个后果）",
    ).toBeTruthy();

    fake.finish(String(shared.read().runningRequestId));
    await second;
    expect(shared.read().runningRequestId).toBeNull();
  });

  it("两条流用的是**不同**的句柄（终止/收尾打不到对方身上）", async () => {
    const shared = makePort({});
    const first = runStream(shared.port, "一", "系统", () => undefined, [], "task-1");
    await settle(() => shared.read().runningRequestId, "第一轮");
    const firstId = String(shared.read().runningRequestId);
    const second = runStream(shared.port, "二", "系统", () => undefined, [], "task-1");
    await settle(() => shared.read().runningRequestId && String(shared.read().runningRequestId) !== firstId, "第二轮");
    const secondId = String(shared.read().runningRequestId);

    expect(firstId).not.toBe(secondId);
    /* 两条各自结束，互不影响（正常收尾不该调用 abort） */
    fake.finish(firstId);
    await first;
    fake.finish(secondId);
    await second;
    expect(fake.aborted).toEqual([]);
  });

  it("⭐ 按会话中止：只停**那一段对话**的轮次，另一段原样还在跑", async () => {
    /*
     * 这是「停止打错对象」的正面判据：单值句柄时代，`abortRunning` 停的永远是
     * **最后注册的那一条** —— 用户点「停止」（他在看 A 那段）却把 B 停了，
     * 而 A 的流继续跑，界面上看起来"点了没反应"。
     */
    const shared = makePort({});
    const turnA = runStream(shared.port, "A 的第一句", "系统", () => undefined, [], "task-a");
    await settle(() => shared.read().runningRequestId, "A 的第一轮");
    const idA = String(shared.read().runningRequestId);
    const turnB = runStream(shared.port, "B 的第一句", "系统", () => undefined, [], "task-b");
    await settle(() => shared.read().runningRequestId && String(shared.read().runningRequestId) !== idA, "B 的第一轮");
    const idB = String(shared.read().runningRequestId);

    abortRunning(shared.port, "task-a");

    await turnA; // A 被本地 settle（`handle.abort()` 会抛一条「已中止」），于是收尾
    expect(fake.aborted, "中止该落在 A 那一条请求上").toEqual([idA]);
    expect(shared.read().runningRequestId, "B 还在跑 —— 这一段对话没被碰过").toBe(idB);
    expect(fake.aborted).not.toContain(idB);

    fake.finish(idB);
    await turnB;
    expect(shared.read().runningRequestId).toBeNull();
  });
});
