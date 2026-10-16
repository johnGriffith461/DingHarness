import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCursorJournal } from "../adapters/syncCursorJournal";
import { kvWrite } from "../adapters/kvStore";
import { createSqliteSessionStore } from "../adapters/sqliteStore";
import { chatSessionId, type LogRecord } from "../core/events";
import { createSyncCursor, type CursorState } from "./cursor";
import { eventIdOf, outboxOf, resumeMatches } from "./outbox";
import { createSyncRelay } from "./relay";

/**
 * **离线续传**（V5-2 任务 2.6）：杀进程重连之后接着推，中继那条流与本地记录
 * **逐条一致（diff=0）**。
 *
 * 这一组用真的 SQLite 本地库 + 真的中继 + 真的游标账本跑一遍"进程死掉"：
 *
 * ```
 * ① 一轮正常推（游标落账）
 * ② 「进程被杀」：内存里的一切丢掉，只剩本地库与账本
 * ③ 重连：账本读回游标 → 从**本地记录**重建出站队列（不另存队列）→ 接着推
 * ④ 判据：中继那条流 == 本地记录（条数/顺序/内容逐条相等）
 * ```
 *
 * ⚠️ 这一组的价值在于它挡的是"两套账"：队列若单独存一份，就会与本地记录漂移
 * （少推、重推、顺序乱），而"本地 SQLite 是权威"这条不变量正是为了不让那种事发生。
 */

let dir: string;
let opened: { close(): void }[] = [];

function openStore() {
  const store = createSqliteSessionStore(dir);
  opened.push(store);
  return store;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dh-resume-"));
  opened = [];
});

afterEach(() => {
  for (const store of opened) store.close();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* Windows 占用是一次性冲突，别把它判成失败 */
  }
});

const req = (text: string) =>
  ({
    requestId: "r1",
    type: "request",
    provider: "p",
    model: "m",
    messages: [{ role: "user", content: text }],
  }) as never;

describe("2.6 · 出站队列从本地记录推出来（不另存一份账）", () => {
  it("游标没推过 → 全推；推过 → 只推新的那一段；事件 id 由（会话 id, 本地 seq）拼成", () => {
    const records = [
      { seq: 1, at: 1, requestId: "r", type: "text", text: "甲" },
      { seq: 2, at: 2, requestId: "r", type: "text", text: "乙" },
      { seq: 3, at: 3, requestId: "r", type: "text", text: "丙" },
    ] as unknown as LogRecord[];
    expect(outboxOf("task-1", records, null).map((e) => e.id)).toEqual(["task-1#1", "task-1#2", "task-1#3"]);
    const pending = outboxOf("task-1", records, { pushedSeq: 2 });
    expect(pending.map((e) => e.id)).toEqual(["task-1#3"]);
    expect(pending[0]?.type).toBe("text");
    /* payload 是记录本体**去掉 seq**（seq 属于本地编号，不搬到对端当身份） */
    expect(pending[0]?.payload).toEqual({ at: 3, requestId: "r", type: "text", text: "丙" });
  });

  it("id 唯一一份拼法（别处手抄会漂）", () => {
    expect(eventIdOf("task-9", 12)).toBe("task-9#12");
  });
});

describe("2.6 · 杀进程重连 → 续传 diff=0（真 SQLite + 真中继 + 真账本）", () => {
  it("⭐ 推一半被杀 → 账本读回游标 → 从本地记录接着推 → 流与本地逐条一致", async () => {
    const sid = chatSessionId("resume");
    const store = openStore();
    await store.append(sid, [req("第一句")]);
    await store.append(sid, [
      { requestId: "r1", type: "text", text: "回一" } as never,
      { requestId: "r1", type: "text", text: "回二" } as never,
    ]);
    const local = (await store.load(sid)).records;
    expect(local).toHaveLength(3);

    const relay = createSyncRelay({ now: () => 1_700_000_000_000 });
    relay.createStream(sid);
    const journal = createCursorJournal(dir);

    /* ① 第一个"进程"：接管 + 推前两条 + 把游标落账 */
    {
      const claimed = relay.claim(sid, "手机");
      const epoch = claimed.ok ? claimed.epoch : 0;
      const cursor = createSyncCursor(relay, {
        streamId: sid,
        producerId: "手机-p1",
        state: { streamId: sid, producerId: "手机-p1", epoch, pushedSeq: 0, pulledOffset: 0 },
      });
      const pending = outboxOf(sid, local.slice(0, 2), cursor.state());
      expect(cursor.push(pending)).toMatchObject({ ok: true, pushed: 2 });
      journal.save(cursor.state());
      expect(relay.state(sid)?.nextOffset).toBe(3);
    }

    /* ② 「进程被杀」：这个作用域里的 cursor 对象没有了 —— 只剩本地库与账本 */

    /* ③ 重连：账本读回游标 → 出站队列从**本地记录**重建 → 接着推 */
    const restored = journal.load(sid);
    expect(restored.status).toBe("ok");
    if (restored.status !== "ok") return;
    expect(restored.cursor).toMatchObject({ pushedSeq: 2, pulledOffset: 0 });

    const cursor2 = createSyncCursor(relay, {
      streamId: sid,
      producerId: "手机-p1",
      state: restored.cursor,
    });
    /* 重连之后**先把欠账推完**（`at` 与 id 都由本地记录给 —— 崩几次都是同一批 id） */
    const again = outboxOf(sid, local, cursor2.state());
    expect(again.map((e) => e.id)).toEqual([eventIdOf(sid, 3)]);
    expect(cursor2.push(again), "重连后推不上去（token 过期？游标没读回？）").toMatchObject({ ok: true, pushed: 1 });
    journal.save(cursor2.state());

    /* ④ 判据：中继那条流与本地记录**逐条一致**（续传 diff=0） */
    const pulled = relay.pull(sid, { from: 0 });
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(resumeMatches(sid, local, pulled.events), "续传之后流与本地不一致").toBe(true);
    expect(pulled.events).toHaveLength(3);

    /* 顺带：本地又长了一条 → 再推只推新的那条（游标在，不重发） */
    await store.append(sid, [{ requestId: "r1", type: "done" } as never]);
    const grown = (await store.load(sid)).records;
    const more = outboxOf(sid, grown, cursor2.state());
    expect(more.map((e) => e.id)).toEqual([eventIdOf(sid, 4)]);
    expect(cursor2.push(more)).toMatchObject({ ok: true, pushed: 1 });
    const finalPage = relay.pull(sid, { from: 0 });
    if (finalPage.ok) expect(resumeMatches(sid, grown, finalPage.events)).toBe(true);
  });

  it("⭐ ack 丢了（崩在「推成功但没落账」之后）：重推同一批被去重，流里不出现两次", async () => {
    const sid = chatSessionId("lost-ack");
    const store = openStore();
    await store.append(sid, [req("一句话"), { requestId: "r1", type: "text", text: "回一" } as never]);
    const local = (await store.load(sid)).records;

    const relay = createSyncRelay();
    relay.createStream(sid);
    const claimed = relay.claim(sid, "手机");
    const epoch = claimed.ok ? claimed.epoch : 0;

    /* 推成功，但"落账"那一步没发生（模拟崩在两句之间） */
    const cursor = createSyncCursor(relay, {
      streamId: sid,
      producerId: "p1",
      state: { streamId: sid, producerId: "p1", epoch, pushedSeq: 0, pulledOffset: 0 },
    });
    expect(cursor.push(outboxOf(sid, local, null))).toMatchObject({ ok: true, pushed: 2 });

    /* 重连：账本里还是旧的（pushedSeq 0）→ 重推同一批 → **幂等去重** */
    const stale: CursorState = { streamId: sid, producerId: "p1", epoch, pushedSeq: 0, pulledOffset: 0 };
    const cursor2 = createSyncCursor(relay, { streamId: sid, producerId: "p1", state: stale });
    expect(cursor2.push(outboxOf(sid, local, stale))).toMatchObject({ ok: true, pushed: 0, duplicates: 2 });

    const pulled = relay.pull(sid, { from: 0 });
    if (pulled.ok) {
      expect(pulled.events, "重推在流里出现了两次").toHaveLength(2);
      expect(resumeMatches(sid, local, pulled.events)).toBe(true);
    }
  });
});

describe("2.6 · 游标账本（engine/adapters/syncCursorJournal.ts）", () => {
  it("三态如实：没有 / 有 / 坏了（坏了**不当没有**，带一句说明）", () => {
    const journal = createCursorJournal(dir);
    expect(journal.load("task-x")).toEqual({ status: "missing" });

    const cursor: CursorState = { streamId: "task-x", producerId: "p", epoch: 1, pushedSeq: 5, pulledOffset: 4 };
    journal.save(cursor);
    expect(journal.load("task-x")).toEqual({ status: "ok", cursor });

    /* 另一段会话的游标互不影响 */
    journal.save({ ...cursor, streamId: "task-y", pushedSeq: 9 });
    expect(journal.all()).toHaveLength(2);
    expect(journal.load("task-x")).toMatchObject({ status: "ok", cursor: { pushedSeq: 5 } });

    /* 账本文件被手改坏 → corrupt（带说明），而不是静默当空 */
    kvWrite(dir, path.join(dir, "sync-cursors.json"), { 这不是账本: true });
    const broken = journal.load("task-x");
    expect(broken.status).toBe("corrupt");
    if (broken.status === "corrupt") expect(broken.note, "坏账的说明要能看出是「读不出/形状不对」").toMatch(/读不出来|形状不对/);
  });
});
