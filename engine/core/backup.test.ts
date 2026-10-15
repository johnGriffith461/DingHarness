import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqliteSessionStore } from "../adapters/sqliteStore";
import { chatSessionId, taskSessionId, type LogInput } from "./events";
import { BACKUP_VERSION, applyBackup, buildBackup, describeBackup, validateBackup, type BackupPayload } from "./backup";

/**
 * 备份 / 恢复（Phase 12.3）。
 *
 * 方案的验收是「**恢复后评测集重放行为一致 —— 数据是用户的**」。
 * 这条在这里落成两件事：
 *   ① roundtrip 之后**投影出来的东西一字不差**（用 `resumeSession` 比，不比文件字节）；
 *   ② 恢复**不删不覆盖**（备份比现在旧时，现在的数据还在）。
 */

let dir = "";
const opened: Array<{ close: () => void }> = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dh-backup-"));
  opened.length = 0;
});

afterEach(() => {
  for (const s of opened) s.close();
  rmSync(dir, { recursive: true, force: true });
});

function openStore(d = dir) {
  const store = createSqliteSessionStore(d);
  opened.push(store);
  return store;
}

const req = (text: string, requestId = "r1"): LogInput => ({
  requestId,
  type: "request",
  provider: "strata",
  model: "m",
  messages: [{ role: "user", content: text }],
  toolPolicy: "按需确认",
  tools: [],
});

describe("备份与恢复（Phase 12.3）", () => {
  it("① roundtrip：恢复之后那段会话投影出来与原来一字不差", async () => {
    const store = openStore();
    const sid = chatSessionId("bk");
    await store.append(sid, [req("第一句"), { requestId: "r1", type: "text", text: "回一句" }]);
    await store.append(sid, [{ requestId: "r2", type: "text", text: "第二句的回答" }]);

    const before = await store.load(sid);
    const payload = buildBackup({
      fromDataDir: dir,
      sessions: [{ sessionId: sid, records: before.records }],
      stores: [{ key: "demo", value: { __schema: 1, data: { items: ["甲"] } } }],
      config: { provider: "strata", mode: "按需确认" },
    });
    expect(payload.kind).toBe("ding-harness-backup");
    expect(payload.version).toBe(BACKUP_VERSION);
    expect(payload.summary.records).toBe(before.records.length);

    // 换一个干净的数据目录恢复（模拟"换机器"）
    const fresh = mkdtempSync(path.join(tmpdir(), "dh-backup2-"));
    let target: ReturnType<typeof createSqliteSessionStore> | null = null;
    try {
      /*
       * ⚠️ 这个 store **不放进 `opened`**：它要在 `finally` 里删目录之前先关掉 ——
       * Windows 上库文件被句柄占着时删目录是硬失败（`SessionStore.close` 的注释记过这条）。
       */
      target = createSqliteSessionStore(fresh);
      const stores: Array<{ key: string; value: unknown }> = [];
      const report = await applyBackup(payload, {
        loadSession: (id) => target!.load(id),
        appendSession: (id, recs) => target!.append(id, recs),
        writeStore: (k, v) => {
          stores.push({ key: k, value: v });
        },
        writeConfig: () => undefined,
      });

      expect(report.recordsAdded).toBe(before.records.length);
      expect(report.recordsSkipped).toBe(0);
      expect(report.configRestored).toBe(true);
      // 配置型 store 也回来了（值是信封，原样放回）
      expect(stores).toEqual([{ key: "demo", value: { __schema: 1, data: { items: ["甲"] } } }]);

      const after = await target.load(sid);
      /* 判据是**投影一致**，不是文件字节一致 —— 存储自己会重新编号，那是它的权利 */
      expect(JSON.stringify(after.records.map((r) => ({ ...r, seq: 0, at: 0 })))).toBe(
        JSON.stringify(before.records.map((r) => ({ ...r, seq: 0, at: 0 }))),
      );
      expect(after.records.length).toBe(before.records.length);
    } finally {
      target?.close();
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("② 恢复**不删不覆盖**：备份比现在旧时，现在的数据还在", async () => {
    const store = openStore();
    const sid = taskSessionId("live");

    // 先做一份"三天前的备份"
    await store.append(sid, [req("那时候的一句话")]);
    const old = await store.load(sid);
    const payload = buildBackup({ fromDataDir: dir, sessions: [{ sessionId: sid, records: old.records }], stores: [] });

    // 之后用户又聊了一堆（同一个会话、后面又追加了记录）
    await store.append(sid, [{ requestId: "r2", type: "text", text: "后来又说的话" }]);
    const now = await store.load(sid);
    expect(now.records.length).toBeGreaterThan(old.records.length);

    // 恢复那份旧备份
    const report = await applyBackup(payload, {
      loadSession: (id) => store.load(id),
      appendSession: (id, recs) => store.append(id, recs),
      writeStore: () => undefined,
    });

    expect(report.recordsAdded, "旧备份不该再往库里塞重复记录").toBe(0);
    expect(report.recordsSkipped).toBe(old.records.length);
    const after = await store.load(sid);
    // 现在的记录**一条都没少**（"后来又说的话"还在）
    expect(after.records.length).toBe(now.records.length);
    expect(JSON.stringify(after.records)).toContain("后来又说的话");
  });

  it("③ 坏备份要说清哪里坏，而不是崩", () => {
    expect(validateBackup(null)).toEqual({ ok: false, reason: expect.stringContaining("不是一个对象") });
    expect(validateBackup({})).toEqual({ ok: false, reason: expect.stringContaining("不是本程序的备份") });
    expect(validateBackup({ kind: "ding-harness-backup", version: BACKUP_VERSION + 1, sessions: [], stores: [] })).toEqual({
      ok: false,
      // ⚠️ 更高版本的备份**不猜着恢复**：可能有不认识的字段，恢复出来是半截数据
      reason: expect.stringContaining("升级之后再恢复"),
    });
    expect(validateBackup({ kind: "ding-harness-backup", version: 1, sessions: {}, stores: [] })).toEqual({
      ok: false,
      reason: expect.stringContaining("sessions"),
    });
    const good = buildBackup({ fromDataDir: dir, sessions: [], stores: [] });
    const checked = validateBackup(JSON.parse(JSON.stringify(good)));
    expect(checked.ok).toBe(true);
  });

  it("④ 清单（`--list`）说的是实话：会话数、记录数、最大的几段", () => {
    const payload: BackupPayload = buildBackup({
      fromDataDir: "C:/somewhere",
      sessions: [
        { sessionId: chatSessionId("a"), records: [req("x", "r1") as never] },
        { sessionId: chatSessionId("b"), records: [req("x", "r1") as never, req("y", "r2") as never] },
      ],
      stores: [],
      now: new Date("2026-10-15T00:00:00Z"),
    });
    const text = describeBackup(payload);
    expect(text).toContain("C:/somewhere");
    expect(text).toContain("会话 2 段");
    expect(text).toContain("记录 3 条");
    // 最大的那段排前面
    expect(text.indexOf(chatSessionId("b"))).toBeLessThan(text.indexOf(chatSessionId("a")));
  });

  it("⑤ 恢复时给空备份：不报错，报告是零", async () => {
    const store = openStore();
    const payload = buildBackup({ fromDataDir: dir, sessions: [], stores: [] });
    const report = await applyBackup(payload, {
      loadSession: (id) => store.load(id),
      appendSession: (id, recs) => store.append(id, recs),
      writeStore: () => undefined,
    });
    expect(report).toEqual({ sessions: 0, recordsAdded: 0, recordsSkipped: 0, stores: 0, configRestored: false });
  });
});
