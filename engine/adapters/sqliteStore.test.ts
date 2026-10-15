import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqliteSessionStore, migrateJsonlSessions } from "./sqliteStore";
import { chatSessionId, logLine, resumeSession, taskSessionId, type LogInput } from "../core/events";

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

  it("⭐ 保留策略：超条数从**最旧的整会话**淘汰（不是把一个会话截成半截）", async () => {
    /*
     * ⚠️ 收口发生在**打开时**（与 JSONL 那版"启动时清理"同一个时机），
     * 不在每次 append 之后 —— 所以这里显式调一次 `prune()`。
     * 开着应用跑一整天时，库会略微超过上限，下一次启动收回来；
     * 这与既有行为一致（JSONL 那版也不在每次写入后扫目录）。
     */
    const store = createSqliteSessionStore(dir, "sessions.db", { maxSessions: 2 });
    for (const id of ["c1", "c2", "c3"]) {
      await store.append(chatSessionId(id), [request(`对话 ${id}`)]);
      await new Promise((r) => setTimeout(r, 3)); // 让 updated_at 拉开，好判"最旧"
    }
    expect((await store.list()).map((x) => x.conversationId)).toEqual(["c3", "c2", "c1"]);

    const got = await store.prune();
    expect(got.deleted, "淘汰的必须是最旧的那个（整会话）").toEqual([chatSessionId("c1")]);
    expect(got.kept).toBe(2);
    // 被淘汰的会话连事件一起走（不留孤儿行）
    expect((await store.load(chatSessionId("c1"))).records).toEqual([]);

    // 重开一次：打开时又收一次口，仍然只有 2 个（不会因为重开而漂移）
    store.close();
    const again = createSqliteSessionStore(dir, "sessions.db", { maxSessions: 2 });
    expect((await again.list()).map((x) => x.conversationId)).toEqual(["c3", "c2"]);
    again.close();
  });

  it("保留策略：容量超限时整会话淘汰（被淘汰的会话连事件一起走）", async () => {
    const store = createSqliteSessionStore(dir);
    await store.append(chatSessionId("old"), [request("老的")]);
    await new Promise((r) => setTimeout(r, 3));
    await store.append(chatSessionId("new"), [request("新的")]);
    const rows = await store.list();
    const newestBytes = rows.find((r) => r.conversationId === "new")?.bytes ?? 0;

    // 只留得下"新的"那一个 → 打开时收口就会把 old 整会话淘汰
    store.close();
    const tight = createSqliteSessionStore(dir, "sessions.db", { maxBytes: newestBytes + 10 });
    expect((await tight.list()).map((x) => x.conversationId)).toEqual(["new"]);
    // 事件也一起删了（不是留下孤儿行）
    expect((await tight.load(chatSessionId("old"))).records).toEqual([]);
    tight.close();
  });

  it("保留策略：年龄超限删掉（maxAgeDays: 0 等价于'只留此刻之后写的'）", async () => {
    const store = createSqliteSessionStore(dir);
    await store.append(chatSessionId("ancient"), [request("很久以前")]);
    store.close();
    const aggressive = createSqliteSessionStore(dir, "sessions.db", { maxAgeDays: 0 });
    expect(await aggressive.list()).toEqual([]);
    aggressive.close();
  });

  it("⭐ 保护线（protectBefore）：外部流量收口不得淘汰用户自有会话", async () => {
    /*
     * 审计 P173：服务态**每来一个请求就打开一次库**，而打开即收口。
     * 不带保护线时，能连上服务的人只要不停换 sessionId，就能把用户历史
     * 按"最旧的先删"整段挤掉 —— 不可逆的数据损失。
     */
    const seeded = createSqliteSessionStore(dir);
    await seeded.append(chatSessionId("mine-1"), [request("我的老会话 A")]);
    await new Promise((r) => setTimeout(r, 3));
    await seeded.append(chatSessionId("mine-2"), [request("我的老会话 B")]);
    seeded.close();

    const protectBefore = Date.now() + 1; // 服务启动时刻：上面两个都在它之前（都是"用户自己的"）
    await new Promise((r) => setTimeout(r, 3));

    /* 服务期间又被造了 3 个（上限 4：受保护 2 + 未受保护配额 2）→ 只淘汰最旧的那个未受保护的 */
    const serving = createSqliteSessionStore(dir, "sessions.db", { maxSessions: 4 }, { protectBefore });
    for (const id of ["srv-1", "srv-2", "srv-3"]) {
      await serving.append(chatSessionId(id), [request(`服务态建的 ${id}`)]);
      await new Promise((r) => setTimeout(r, 3));
    }
    const got = await serving.prune();
    expect(got.deleted, "淘汰的必须只是服务期间建的那个").toEqual([chatSessionId("srv-1")]);
    expect((await serving.list()).map((x) => x.conversationId).sort()).toEqual(["mine-1", "mine-2", "srv-2", "srv-3"]);
    serving.close();

    /* 对照：**不带**保护线时同一份数据会被淘汰掉用户的两个 —— 说明拦住它的是保护线本身 */
    const plain = createSqliteSessionStore(dir, "sessions.db", { maxSessions: 2 });
    const left = (await plain.list()).map((x) => x.conversationId);
    expect(left).not.toContain("mine-1");
    expect(left).not.toContain("mine-2");
    plain.close();
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

describe('本地检索（Phase 12.4：FTS + LIKE 并集）', () => {
  it('中文按子串搜得到（FTS 的内置分词器对中文不分词 —— 靠 LIKE 那条兜底）', async () => {
    const store = openStore();
    await store.append(chatSessionId('cn'), [request('明天十点开会讨论预算')]);
    const hits = await store.search('预算');
    expect(hits.map((h) => h.sessionId)).toContain(chatSessionId('cn'));
    // 摘要是**正文**那一句（不是整行 JSON）
    expect(hits[0]?.excerpt).toContain('预算');
    expect(hits[0]?.excerpt).not.toContain('requestId');
  });

  it('英文搜得到，且只命中说过它的那段会话', async () => {
    const store = openStore();
    await store.append(chatSessionId('en'), [request('review the budget tomorrow')]);
    await store.append(taskSessionId('other'), [request('完全无关的一句话')]);
    const hits = await store.search('budget');
    expect(hits.map((h) => h.sessionId)).toEqual([chatSessionId('en')]);
  });

  it('搜不到的词给空数组（不是返回全部）', async () => {
    const store = openStore();
    await store.append(chatSessionId('x'), [request('一些内容')]);
    expect(await store.search('不存在的词')).toEqual([]);
  });

  it('空串 = 空结果：回车不该刷出所有会话', async () => {
    const store = openStore();
    await store.append(chatSessionId('x'), [request('一些内容')]);
    expect(await store.search('')).toEqual([]);
    expect(await store.search('   ')).toEqual([]);
  });

  it('命中最多的会话排前面（多个会话都命中时）', async () => {
    const store = openStore();
    await store.append(chatSessionId('many'), [request('预算'), request('预算'), request('预算')]);
    await store.append(chatSessionId('one'), [request('预算')]);
    const hits = await store.search('预算');
    expect(hits[0]?.sessionId).toBe(chatSessionId('many'));
    expect(hits[0]?.hits).toBeGreaterThan(hits[1]?.hits ?? 0);
  });

  it('用户打的 % 与 _ 是普通字符，不是通配符', async () => {
    const store = openStore();
    await store.append(chatSessionId('pct'), [request('折扣 50% 起')]);
    await store.append(chatSessionId('plain'), [request('折扣 500 起')]);
    const hits = await store.search('%');
    expect(hits.map((h) => h.sessionId)).toEqual([chatSessionId('pct')]);
  });
});
