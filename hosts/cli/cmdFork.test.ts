import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import type { LogInputAt } from "../../engine/ports/store";
import { cmdFork } from "./cmdFork";
import type { Parsed } from "./args";

/**
 * `ding fork`（V6-4a）。
 *
 * 判据：从第 N 轮分叉出来的新会话，记录**只到那一轮收尾**，
 * 且新会话自己能 `load` 回来（不是只写了一行指针）。
 */

const dirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-fork-cli-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function seedSession(dataDir: string, sessionId: string): Promise<void> {
  const store = createSqliteSessionStore(dataDir);
  const records: LogInputAt[] = [
    { requestId: "r1", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "第一件事" }] },
    { requestId: "r1", type: "text", text: "第一轮回完了" },
    { requestId: "r1", type: "done" },
    { requestId: "r2", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "第二件事" }] },
    { requestId: "r2", type: "text", text: "第二轮回完了" },
    { requestId: "r2", type: "done" },
  ] as LogInputAt[];
  await store.append(sessionId, records);
  store.close();
}

const parsed = (args: string[], flags: Record<string, string[]> = {}): Parsed => ({
  command: "fork",
  args,
  flags: new Map(Object.entries(flags)),
});

describe("ding fork", () => {
  it("⭐ --at-turn 1：新会话只有第一轮的记录，第二轮不在", async () => {
    const dir = tmp();
    await seedSession(dir, "cli-a");
    const quiet = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const code = await cmdFork(parsed(["cli-a"], { "at-turn": ["1"], into: ["cli-a-fork"] }), dir);
    expect(code).toBe(0);
    expect(quiet.mock.calls.join("\n")).toContain("复制 3 条记录");

    const store = createSqliteSessionStore(dir);
    const { records } = await store.load("cli-a-fork");
    store.close();
    expect(records).toHaveLength(3);
    expect(records.every((r) => (r as { requestId?: string }).requestId === "r1")).toBe(true);
  });

  it("不给时点 = 整段复制（与桌面既有 fork 同义）", async () => {
    const dir = tmp();
    await seedSession(dir, "cli-b");
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await cmdFork(parsed(["cli-b"], { into: ["cli-b-fork"] }), dir)).toBe(0);

    const store = createSqliteSessionStore(dir);
    const { records } = await store.load("cli-b-fork");
    store.close();
    expect(records).toHaveLength(6);
  });

  it("目标已有内容 → 拒绝（不往别人的会话里追加）", async () => {
    const dir = tmp();
    await seedSession(dir, "cli-c");
    await seedSession(dir, "cli-c-existing");
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const code = await cmdFork(parsed(["cli-c"], { "at-turn": ["1"], into: ["cli-c-existing"] }), dir);
    expect(code).toBe(2);
    expect(err.mock.calls.join("\n")).toContain("已经有内容");
  });

  it("时点越界 → 退出码 2，不复制", async () => {
    const dir = tmp();
    await seedSession(dir, "cli-d");
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await cmdFork(parsed(["cli-d"], { "at-turn": ["9"], into: ["cli-d-fork"] }), dir)).toBe(2);

    const store = createSqliteSessionStore(dir);
    const { records } = await store.load("cli-d-fork");
    store.close();
    expect(records).toHaveLength(0);
  });
});
