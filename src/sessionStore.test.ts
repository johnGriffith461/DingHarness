import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logLine, type LogInput } from "@engine/core/events";

/**
 * 桌面会话存储（Phase 4.3：SQLite + 旧 jsonl 迁移）。
 *
 * ## 这一组要挡住的三件事
 *
 * 1. **会话 id 是渲染进程给的** —— 它进 SQL 也进磁盘路径。收窄写漏了就等于
 *    "渲染进程能决定读写 userData 之外的哪"。这种洞不会自己报错。
 * 2. **老用户升级上来的历史不能丢**（迁移），而且**不能重复迁**（幂等）。
 *    "第一眼是空列表"这类问题在开发机上永远看不到 —— 开发机没有旧数据。
 * 3. **迁移不许删旧文件**：迁到一半崩掉时，损失上限只能是"重跑一次"。
 *
 * 手法与 `ipcStores.test.ts` 一致：把 `electron` mock 掉，
 * `app.getPath("userData")` 指向临时目录，于是主进程的落盘成了可直测的纯 IO。
 */

const env = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => env.userData },
}));

/**
 * 取一份**全新的**模块实例。
 *
 * ⚠️ 必须每次重取：模块里那个 store 是**进程内单例**（惰性缓存），
 * 不重置的话第二个用例会看到第一个用例留下的数据 —— 这类"测试之间串数据"
 * 会造成比它挡住的 bug 更难查的假红/假绿。
 */
async function fresh() {
  vi.resetModules();
  return await import("../electron/ipc/sessionStore");
}

/** 一次 IPC 注册里捕获到的处理函数。 */
const handlers: Record<string, (...args: unknown[]) => unknown> = {};

function fakeIpcMain() {
  return {
    handle: (ch: string, fn: (...args: unknown[]) => unknown) => {
      handlers[ch] = fn;
    },
  };
}

/** 注册一次 IPC 并把两个处理函数取出来。 */
async function withIpc() {
  const mod = await fresh();
  for (const key of Object.keys(handlers)) delete handlers[key];
  mod.registerSessionIpc(fakeIpcMain() as never);
  return {
    mod,
    list: () => handlers["session:list"]!() as Promise<Array<{ sessionId: string; conversationId: string; title: string }>>,
    load: (id: unknown) => handlers["session:load"]!(null, id) as Promise<{ records: unknown[]; skipped: number }>,
  };
}

/** 造旧格式的一行（`.jsonl` 里的形状）。 */
function line(record: LogInput, seq: number): string {
  return logLine(record, seq, 1_700_000_000_000 + seq);
}

/**
 * 造一条**合法**的流事件。
 *
 * ⚠️ `requestId` 不能省：`parseLogLine` 要求流事件带着它，少了就**不算一条合法记录**，
 * `load` 会把它算进 `skipped`（这是既有的口径，不是这次引入的）。
 * 写这些用例时第一版就漏了它，于是"写进去 3 条、读回来 1 条"——
 * 那不是存储的错，是测试数据不合法。
 */
function ev(e: Record<string, unknown>): LogInput {
  return { requestId: "r1", ...e } as LogInput;
}

/** 造一轮请求记录（会话的"一轮开始"）。 */
function request(text: string): LogInput {
  return {
    type: "request",
    requestId: "r1",
    provider: "deepseek",
    model: "deepseek-chat",
    messages: [{ role: "user", content: text }],
  } as LogInput;
}

beforeEach(() => {
  env.userData = mkdtempSync(path.join(os.tmpdir(), "dh-session-"));
});

afterEach(() => {
  try {
    rmSync(env.userData, { recursive: true, force: true });
  } catch {
    /* Windows 上句柄可能还占着：尽力而为，不因此判红 */
  }
});

describe("会话 id 收窄（渲染进程给的东西当路径用之前）", () => {
  it("正常 id：对话 id 与任务 id 都过得去", async () => {
    const { safeSessionId } = await fresh();
    expect(safeSessionId("c1")).toBe("c1");
    expect(safeSessionId("c-1700000000000-3")).toBe("c-1700000000000-3");
    expect(safeSessionId("task_abc.1")).toBe("task_abc.1");
    expect(safeSessionId("  c1  ")).toBe("c1"); // 前后空白容忍
  });

  it("⭐ 路径穿越与分隔符一律拒掉（否则渲染进程能决定读到 userData 之外的哪）", async () => {
    const { safeSessionId } = await fresh();
    for (const bad of [
      "../../evil",
      "..\\..\\evil",
      "a/b",
      "a\\b",
      "/abs",
      "C:\\Users\\x",
      ".hidden",
      "..",
      ".",
      "...",
      "with space",
      "带中文",
      "a:b",
      "a*b",
      "",
      "   ",
    ]) {
      expect(safeSessionId(bad), `应拒掉：${JSON.stringify(bad)}`).toBeNull();
    }
  });
});

describe("会话库的读接口（list / load）", () => {
  it("⭐ 写进去的一轮能被列出来并原样读回（标题取自第一条用户消息）", async () => {
    const { mod, list, load } = await withIpc();
    const id = "chat-c1";
    await mod.desktopSessionStore().append(id, [
      request("把散落的 md 整理成一份纪要\n第二行"),
      ev({ type: "text", text: "好的" }),
      ev({ type: "done" }),
    ]);

    const sessions = await list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: id, conversationId: "c1", title: "把散落的 md 整理成一份纪要" });

    const got = await load(id);
    expect(got.records).toHaveLength(3);
    expect(got.skipped).toBe(0);
  });

  it("只列聊天会话（任务日志在同一个库里，但不该冒充对话）", async () => {
    const { mod, list } = await withIpc();
    await mod.desktopSessionStore().append("chat-c1", [request("聊天")]);
    await mod.desktopSessionStore().append("task-t1", [request("任务")]);
    expect((await list()).map((s) => s.sessionId)).toEqual(["chat-c1"]);
  });

  it("id 不合法 / 不存在的会话：给空，不抛（渲染层不必为它写 try）", async () => {
    const { load } = await withIpc();
    expect(await load("../../evil")).toEqual({ records: [], skipped: 0 });
    expect(await load("chat-不存在")).toEqual({ records: [], skipped: 0 });
  });
});

describe("旧 jsonl 一次性迁移", () => {
  /** 往旧目录塞一份 `.jsonl` 会话。 */
  function seedLegacy(sessionId: string, lines: string[]): string {
    const dir = path.join(env.userData, "sessions");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    writeFileSync(file, lines.join(""), "utf8");
    return file;
  }

  it("⭐ 旧日志被打开展示出来，且旧文件**原样留着**（只读旧、写新、不删旧）", async () => {
    seedLegacy("chat-old", [line(request("上个月的那轮对话"), 1), line(ev({ type: "done" }), 2)]);

    const { list, load } = await withIpc();
    const sessions = await list();
    expect(sessions.map((s) => s.sessionId)).toContain("chat-old");
    expect(sessions[0]?.title).toBe("上个月的那轮对话");
    expect((await load("chat-old")).records).toHaveLength(2);

    // 旧文件必须还在原地
    expect(readdirSync(path.join(env.userData, "sessions")).filter((n) => n.endsWith(".jsonl"))).toEqual(["chat-old.jsonl"]);
  });

  it("⭐ 幂等：第二次启动不再重复迁（记录条数不会翻倍）", async () => {
    seedLegacy("chat-old", [line(request("老对话"), 1), line(ev({ type: "done" }), 2)]);

    const first = await withIpc();
    expect((await first.load("chat-old")).records).toHaveLength(2);

    // 再启动一次（新进程 = 新模块实例，旧文件还在）
    const second = await withIpc();
    expect((await second.load("chat-old")).records).toHaveLength(2);
    expect(await second.list()).toHaveLength(1);
  });

  it("坏行只跳过它自己（迁移时就被丢掉，好行照常进库）", async () => {
    seedLegacy("chat-bad", [
      line(request("有问题的一份"), 1),
      line(ev({ type: "text", text: "好的" }), 2),
      "{坏掉的一行}" + String.fromCharCode(10),
    ]);

    const { load } = await withIpc();
    const got = await load("chat-bad");
    // 两条好行都在；坏的那行在**迁移**时被丢掉（跳过数记在启动日志里，不混进 load 的读数）
    expect(got.records).toHaveLength(2);
    expect(got.skipped).toBe(0);
  });

  it("id 不合法的旧文件名：跳过它，不读也不迁（`../` 这类不能借迁移跑到别处）", async () => {
    const dir = path.join(env.userData, "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "..evil.jsonl"), line(request("不该被读"), 1), "utf8");
    writeFileSync(path.join(dir, "chat-ok.jsonl"), line(request("正常的"), 1), "utf8");

    const { list } = await withIpc();
    expect((await list()).map((s) => s.sessionId)).toEqual(["chat-ok"]);
  });

  it("没有旧目录：当成'没有旧数据'，不是错误", async () => {
    const { list } = await withIpc();
    expect(await list()).toEqual([]);
  });
});
