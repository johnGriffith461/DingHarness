import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqliteSessionStore, migrateJsonlSessions } from "./sqliteStore";
import { chatSessionId, logLine, resumeSession, type LogInput } from "../core/events";

/**
 * SQLite 会话库（Phase 1 D1 的 PoC）。
 *
 * ## 这些断言要挡住的是什么
 *
 * 换存储是一次"全仓最不该出错"的改动：**出错不会崩，只会悄悄少东西**
 * （历史少了一轮、批准记录跑到它那一轮前面、某段会话列不出来）。
 * 所以这里断言的都是**可证伪的行为**：编号连不连、顺序对不对、
 * 迁过来的东西还能不能 `resume` 出一模一样的待办。
 */

let dir: string;
/** 本用例建过的 store：**结算时统一 close** —— 句柄没放之前临时目录删不掉（Windows 硬失败）。 */
let opened: { close(): void }[] = [];

/** 建一个 store 并记下来，省得每个用例都记得收尾。 */
function openStore(d = dir) {
  const store = createSqliteSessionStore(d);
  opened.push(store);
  return store;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dh-sqlite-"));
  opened = [];
});

afterEach(() => {
  for (const store of opened) store.close();
  /*
   * ⚠️ 清理**尽力而为**，不让它把一个通过的用例判红。
   *
   * Windows 上 "文件被占用" 是一次性冲突（杀软扫刚写出的文件、句柄还没完全释放），
   * 表现为 EPERM —— 实测遇到过一次：一整轮里 6 条用例被 afterEach 的 rmSync 判红，
   * 而那 6 条断言**其实全过了**。这类"测试自己抖"的代价很实在：
   * 红了先怀疑测试，久了就没人看红了。
   *
   * 所以这里吞掉清理失败（临时目录由系统回收），而不是让它冒充"被测代码坏了"。
   */
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 占着就占着：系统会回收，不因此判红 */
  }
});

/**
 * 造一条流事件。
 *
 * ⚠️ `requestId` 不能省：`parseLogLine` 要求流事件带着它（那是 IPC 归并用的），
 * 少了就**不算一条合法记录** —— 第一次写这些用例时正是栽在这里
 * （`skipped` 报 3，而当时看代码"明明都写进去了"）。
 */
function ev(e: Omit<LogInput & { type: string }, "requestId"> | Record<string, unknown>): LogInput {
  return { requestId: "r1", ...(e as object) } as LogInput;
}

/** 造一条请求记录（会话的"一轮开始"）。 */
function request(text: string): LogInput {
  return {
    type: "request",
    requestId: "r1",
    provider: "deepseek",
    model: "deepseek-chat",
    messages: [{ role: "user", content: text }],
  } as LogInput;
}

describe("SQLite 会话库", () => {
  it("⭐ 追加 → 读回：序号连续、顺序不变、内容一字不差", async () => {
    const store = openStore();
    const sid = chatSessionId("abc");

    const first = await store.append(sid, [request("把散落的 md 整理成纪要")]);
    expect(first.map((r) => r.seq)).toEqual([1]);

    await store.append(sid, [ev({ type: "text", text: "好" }), ev({ type: "text", text: "的" }), ev({ type: "done" })]);

    const { records, skipped } = await store.load(sid);
    expect(skipped).toBe(0);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(records.map((r) => r.type)).toEqual(["request", "text", "text", "done"]);
    const texts = records.filter((r) => r.type === "text").map((r) => (r as { text: string }).text);
    expect(texts.join("")).toBe("好的");
  });

  it("再追加一批接着上一批的序号（两个写入器不会撞号）", async () => {
    const store = openStore();
    const sid = chatSessionId("abc");
    // 模拟"同一会话被第二处写入"（用户点允许之后那次）：序号必须接着走
    await store.append(sid, [ev({ type: "text", text: "a" })]);
    const second = await store.append(sid, [ev({ type: "text", text: "b" })]);
    expect(second[0]?.seq).toBe(2);
  });

  it("列会话：只出聊天那一类，标题取第一条用户消息，最近的在前面", async () => {
    const store = openStore();
    await store.append(chatSessionId("c1"), [request("第一句话\n第二行")]);
    await new Promise((r) => setTimeout(r, 2));
    await store.append(chatSessionId("c2"), [request("第二条对话")]);
    // 工作台任务的日志写进同一个库，但不该混进聊天列表
    await store.append("task-t1", [request("任务日志")]);

    const chats = await store.list({ kind: "chat" });
    expect(chats.map((c) => c.conversationId)).toEqual(["c2", "c1"]);
    expect(chats[1]?.title).toBe("第一句话"); // 取第一行，不带换行
    expect(chats[0]?.title).toBe("第二条对话");
    expect(await store.list({ kind: "task" })).toHaveLength(1);
  });

  it("读一个不存在的会话：给空数组，不是报错", async () => {
    const store = openStore();
    expect(await store.load(chatSessionId("nope"))).toEqual({ records: [], skipped: 0 });
  });

  it("⭐ 迁移：旧 .jsonl 整段搬过来之后，resume 出来的待办与待办数量一致", async () => {
    // 造一份旧格式日志：一轮里有一次被闸门拦下的调用（pending），用户还没处置
    const legacy = mkdtempSync(path.join(tmpdir(), "dh-legacy-"));
    const sid = chatSessionId("old");
    const lines: string[] = [];
    let seq = 0;
    const put = (record: LogInput) => {
      seq += 1;
      lines.push(logLine(record, seq, 1_700_000_000_000 + seq));
    };
    put(request("帮我写个文件"));
    put(ev({ type: "tool-call", toolCallId: "t1", toolName: "write_file", input: { path: "a.md", content: "x" } }));
    put(ev({ type: "tool-result", toolCallId: "t1", toolName: "write_file", output: { pending: true, notice: "等确认" } }));
    put(ev({ type: "done" }));
    writeFileSync(path.join(legacy, `${sid}.jsonl`), lines.join(""), "utf8");

    const store = openStore();
    const got = await migrateJsonlSessions(legacy, store);
    expect(got).toMatchObject({ files: 1, records: 4, skipped: 0 });

    const { records } = await store.load(sid);
    expect(records).toHaveLength(4);

    // 迁移之后语义不变：那条被拦下的调用仍然是"待办"，参数还在（丢了就执行不了）
    const resumed = resumeSession(records);
    expect(resumed.pending).toHaveLength(1);
    expect(resumed.pending[0]).toMatchObject({ toolCallId: "t1", name: "write_file" });
    expect(resumed.pending[0]?.input).toEqual({ path: "a.md", content: "x" });

    // 旧文件**还在**（只读旧、写新、不删旧）
    expect(readdirSync(legacy).filter((n) => n.endsWith(".jsonl"))).toHaveLength(1);
    rmSync(legacy, { recursive: true, force: true });
  });

  it("迁移遇到坏行：只跳过坏的那一行，并把跳过数报出来", async () => {
    const legacy = mkdtempSync(path.join(tmpdir(), "dh-legacy-"));
    const sid = chatSessionId("bad");
    const ok = logLine(ev({ type: "text", text: "好" }), 1, 1);
    writeFileSync(path.join(legacy, `${sid}.jsonl`), `${ok}{坏掉的一行}\n`, "utf8");

    const store = openStore();
    const got = await migrateJsonlSessions(legacy, store);
    expect(got).toMatchObject({ records: 1, skipped: 1 });
    expect((await store.load(sid)).records).toHaveLength(1);
    rmSync(legacy, { recursive: true, force: true });
  });

  it("迁移一个不存在的目录：当成'没有旧数据'，不是错误", async () => {
    const store = openStore();
    mkdirSync(dir, { recursive: true });
    expect(await migrateJsonlSessions(path.join(dir, "nope"), store)).toEqual({
      files: 0,
      records: 0,
      skipped: 0,
    });
  });
});

