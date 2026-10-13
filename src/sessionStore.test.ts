import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const { createSessionLogger, readSessionLog, safeSessionId, sessionLogPath } = await import(
  "../electron/ipc/sessionStore"
);

beforeEach(() => {
  env.userData = mkdtempSync(path.join(os.tmpdir(), "dwc-session-"));
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
