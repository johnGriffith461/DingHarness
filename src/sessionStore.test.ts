import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * C2：会话事件日志的落盘。
 *
 * ## 为什么它必须有断言
 *
 * 这一层是"**模型这一轮看见了什么**"的唯一记录（`docs/PLAN-C2-Agent运行时收敛.md` 的 INV-1）。
 * 它有两个**很容易写错又很难发现**的点：
 *
 * 1. **会话 id 是渲染进程给的，却要当文件名用** —— 收窄写漏了就等于
 *    "渲染进程能决定日志写到磁盘的哪个位置"（`../../` 就能跑出 userData）。
 *    这种洞不会自己报错，只会安安静静地写下去。
 * 2. **追加写会重试** —— 重试与"坏行跳过"必须同时成立：
 *    写坏的只丢那一行，**已写好的那些不许受影响**。
 *
 * ⚠️ 与 `src/ipcStores.test.ts` 同一套手法：把 `electron` mock 掉，
 * `app.getPath("userData")` 指向临时目录，于是主进程的落盘成了可直测的纯 IO。
 */

const env = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => env.userData },
}));

const { SESSION_RETENTION, createSessionLogger, listChatSessions, pruneSessions, readSessionLog, safeSessionId, sessionLogPath } =
  await import("../electron/ipc/sessionStore");

beforeEach(() => {
  env.userData = mkdtempSync(path.join(os.tmpdir(), "dh-session-"));
});

afterEach(() => {
  rmSync(env.userData, { recursive: true, force: true });
});

describe("会话 id 收窄（渲染进程给的东西当文件名用之前）", () => {
  it("正常 id：对话 id 与任务 id 都过得去", () => {
    expect(safeSessionId("c1")).toBe("c1");
    expect(safeSessionId("c-1700000000000-3")).toBe("c-1700000000000-3");
    expect(safeSessionId("task_abc.1")).toBe("task_abc.1");
    expect(safeSessionId("  c1  ")).toBe("c1"); // 前后空白容忍
  });

  it("⭐ 路径穿越与分隔符一律拒掉（否则渲染进程能决定日志写到哪）", () => {
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

  it("非字符串、过长（>64）也拒掉", () => {
    expect(safeSessionId(123)).toBeNull();
    expect(safeSessionId(null)).toBeNull();
    expect(safeSessionId(undefined)).toBeNull();
    expect(safeSessionId({ id: "c1" })).toBeNull();
    expect(safeSessionId("a".repeat(65))).toBeNull();
    expect(safeSessionId("a".repeat(64))).not.toBeNull();
  });

  it("合法 id 的路径落在 userData/sessions 下；非法 id 没有路径", () => {
    const good = sessionLogPath("c1");
    expect(good).toBe(path.join(env.userData, "sessions", "c1.jsonl"));
    expect(sessionLogPath("../../evil")).toBeNull();
  });
});

describe("写入器", () => {
  it("一行一条、seq 单调、落盘之后能原样读回（含首行 request 记录）", async () => {
    const logger = createSessionLogger("c1");
    expect(logger).not.toBeNull();
    logger?.log({
      requestId: "r1",
      type: "request",
      provider: "deepseek",
      model: "deepseek-chat",
      system: "你是助手",
      messages: [{ role: "user", content: "你好" }],
      useTools: true,
    });
    logger?.log({ requestId: "r1", type: "text", text: "你" });
    logger?.log({ requestId: "r1", type: "text", text: "好" });
    logger?.log({ requestId: "r1", type: "done", usage: { inputTokens: 3, outputTokens: 2 } });
    await logger?.flush();

    expect(logger?.count()).toBe(4);
    const text = readFileSync(logger!.file, "utf8");
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(4);
    // 每行都是独立合法的 JSON（一行坏掉不会影响别人）
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();

    const { records, skipped } = await readSessionLog("c1");
    expect(skipped).toBe(0);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(records[0]).toMatchObject({ type: "request", provider: "deepseek", useTools: true });
    expect(records[3]).toMatchObject({ type: "done", usage: { inputTokens: 3, outputTokens: 2 } });
  });

  it("⭐ 写失败不影响对话（非法 id 直接不记，不抛）", () => {
    expect(createSessionLogger("../../evil")).toBeNull();
    expect(() => createSessionLogger("../x")?.log({ requestId: "r", type: "done" })).not.toThrow();
  });

  it("⭐ 坏行只丢它自己：已写好的那些照旧读得出来", async () => {
    const logger = createSessionLogger("c1");
    logger?.log({ requestId: "r1", type: "text", text: "第一句" });
    await logger?.flush();
    // 模拟"写到一半被强杀"：往里塞半行
    writeFileSync(logger!.file, `${readFileSync(logger!.file, "utf8")}{"seq":2,"at":123,"requestId":"r1","ty`, "utf8");

    const { records, skipped } = await readSessionLog("c1");
    expect(records).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it("文件不存在时给空（第一次跑是正常的，不算错误）", async () => {
    expect(await readSessionLog("从来没有过的会话")).toEqual({ records: [], skipped: 0 });
  });
});

describe("列出聊天会话（F3：重启后把对话列表恢复出来）", () => {
  const request = (text: string) => ({
    type: "request" as const,
    requestId: "r1",
    provider: "deepseek",
    model: "deepseek-chat",
    messages: [{ role: "user", content: text }],
  });

  it("⭐ 只列聊天会话（工作台任务的日志在同一个目录里，混进来会多出一堆假对话）", async () => {
    const chat = createSessionLogger("chat-c1");
    chat?.log(request("帮我写个周报"));
    chat?.log({ requestId: "r1", type: "done" });
    const task = createSessionLogger("task-t1");
    task?.log(request("任务那句话"));
    await Promise.all([chat?.flush(), task?.flush()]);

    const list = await listChatSessions();
    expect(list.map((s) => s.sessionId)).toEqual(["chat-c1"]);
    expect(list[0].conversationId).toBe("c1");
  });

  it("标题取第一条用户消息（与发送时的口径一致，超长截断）", async () => {
    const long = "这是一句特别特别长的开场白".repeat(4);
    const a = createSessionLogger("chat-c2");
    a?.log(request(long));
    await a?.flush();

    const [first] = await listChatSessions();
    expect(first.title).toHaveLength(24);
    expect(long.startsWith(first.title)).toBe(true);
  });

  it("最近写入的排在前面；没有日志时给空数组（不抛）", async () => {
    const older = createSessionLogger("chat-old");
    older?.log(request("旧的那段"));
    await older?.flush();
    // 让 mtime 明确拉开
    await new Promise((r) => setTimeout(r, 30));
    const newer = createSessionLogger("chat-new");
    newer?.log(request("新的那段"));
    await newer?.flush();

    const list = await listChatSessions();
    expect(list.map((s) => s.sessionId)).toEqual(["chat-new", "chat-old"]);
  });
});

describe("seq 跨进程续号（真验收抓到的第二个缺陷）", () => {
  it("⭐⭐ 新建写入器时从**已有文件的末号**接着数（否则新记录与旧记录撞号）", async () => {
    /*
     * 场景是实测的：用户重启应用之后才点「允许」——写决策记录的是**新进程**。
     * 每个进程从 1 开始数的话，那条决策会带着 `seq: 1` 落进同一个文件，
     * 读回来按 seq 排序时排到最前面 → 回溯找不到它那一轮 → 留痕永远是"等确认"。
     */
    const first = createSessionLogger("chat-c1");
    first?.log({ requestId: "r1", type: "text", text: "第一进程写的第一条" });
    first?.log({ requestId: "r1", type: "text", text: "第一进程写的第二条" });
    await first?.flush();

    // 模拟"应用重启"：换一个写入器（新进程）
    const second = createSessionLogger("chat-c1");
    second?.log({ requestId: "r1", type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: {} });
    await second?.flush();

    const { records, skipped } = await readSessionLog("chat-c1");
    expect(skipped).toBe(0);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]); // 不许撞号、不许倒序
    expect((records[2] as { toolCallId: string }).toolCallId).toBe("c1");
  });
});

describe("会话日志的保留策略（补完②：原本只增不减）", () => {

  const mk = (name: string, text = "x") => {
    mkdirSync(path.join(env.userData, "sessions"), { recursive: true });
    writeFileSync(path.join(env.userData, "sessions", name), text, "utf8");
  };
  const list = () => readdirSync(path.join(env.userData, "sessions")).sort();

  it("⭐ 超过天数的会话被清掉，新的留着", async () => {
    mk("chat-old.jsonl");
    mk("chat-new.jsonl");
    const old = new Date(Date.now() - 40 * 86400000);
    utimesSync(path.join(env.userData, "sessions", "chat-old.jsonl"), old, old);

    const { deleted, kept } = await pruneSessions();
    expect(deleted).toEqual(["chat-old.jsonl"]);
    expect(kept).toBe(1);
    expect(list()).toEqual(["chat-new.jsonl"]);
  });

  it("⭐ 超过条数上限时从**最旧**的开始删", async () => {
    for (let i = 0; i < 5; i += 1) {
      mk(`chat-${i}.jsonl`);
      const at = new Date(Date.now() - (10 - i) * 3600000); // i 越大越新
      utimesSync(path.join(env.userData, "sessions", `chat-${i}.jsonl`), at, at);
    }
    const { kept } = await pruneSessions({ maxFiles: 2 });
    expect(kept).toBe(2);
    expect(list()).toEqual(["chat-3.jsonl", "chat-4.jsonl"]); // 最旧的三条被删
  });

  it("只认 .jsonl：轮转留档的 .old 不会被当会话列出来，也不会被清", async () => {
    mk("chat-a.jsonl");
    mk("chat-a.1700000000000.jsonl.old");
    // 明确把它做旧（用超小天数的 cutoff 会踩"文件就是刚刚建的"这个边界，不稳）
    const old = new Date(Date.now() - 40 * 86400000);
    utimesSync(path.join(env.userData, "sessions", "chat-a.jsonl"), old, old);
    await pruneSessions();
    expect(list()).toContain("chat-a.1700000000000.jsonl.old");
    expect(list()).not.toContain("chat-a.jsonl");
  });

  it("默认策略写在常量里（改它要改这里，逼一次「想清楚」）", () => {
    expect(SESSION_RETENTION.maxAgeDays).toBe(30);
    expect(SESSION_RETENTION.maxFiles).toBe(200);
    expect(SESSION_RETENTION.maxSessionBytes).toBe(4 * 1024 * 1024);
  });

  it("⭐⭐ 单会话超过上限时**轮转留档**（不删），新文件从 seq=1 重新数", async () => {
    const first = createSessionLogger("chat-big", { maxBytes: 200 });
    first?.log({ requestId: "r1", type: "text", text: "x".repeat(300) });
    await first?.flush();
    const before = list().filter((f) => f.startsWith("chat-big"));
    expect(before.length).toBe(1);

    // 换一个写入器（下一次启动）：文件超限 → 轮转
    const second = createSessionLogger("chat-big", { maxBytes: 200 });
    second?.log({ requestId: "r2", type: "text", text: "新的一轮" });
    await second?.flush();

    const after = list().filter((f) => f.startsWith("chat-big"));
    expect(after.some((f) => f.endsWith(".old"))).toBe(true); // 旧内容留档
    const { records } = await readSessionLog("chat-big");
    expect(records.map((r) => r.seq)).toEqual([1]); // 新文件重新数
  });
});
