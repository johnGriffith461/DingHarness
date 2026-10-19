import { afterEach, describe, expect, it } from "vitest";

import type { ShellBridge } from "@shared/ipc";
import { recordCompaction } from "./taskRuntime";

/**
 * G3：压缩事件回写的**桌面侧**。
 *
 * 真正写库在主进程（`session:append-compaction`，由集成验收覆盖）。
 * 这里钉的是：压缩后确实会发一条带 before/after 的调用；写失败不影响压缩本身。
 */

const calls: Array<{ sessionId: string; info: Record<string, unknown> }> = [];
const original = (globalThis as { shell?: unknown }).shell;

function stub(result: { ok: true } | { ok: false; error: string }): void {
  (globalThis as { shell?: unknown }).shell = {
    session: {
      appendCompaction: (sessionId: string, info: Record<string, unknown>) => {
        calls.push({ sessionId, info });
        return Promise.resolve(result);
      },
    },
  } as unknown as ShellBridge;
}

afterEach(() => {
  calls.length = 0;
  (globalThis as { shell?: unknown }).shell = original;
});

describe("recordCompaction", () => {
  it("压缩后写一条会话事件（tokensAfter < tokensBefore）", async () => {
    stub({ ok: true });
    await recordCompaction("t-1", { tokensBefore: 4000, tokensAfter: 800 });
    expect(calls).toHaveLength(1);
    /* T-01：压缩事件也写在**统一的 task- 会话**下（否则回放时它孤零零挂在裸 id 上） */
    expect(calls[0]!.sessionId).toBe("task-t-1");
    expect(calls[0]!.info).toMatchObject({ tokensBefore: 4000, tokensAfter: 800 });
  });

  it("⭐ 写入失败只留 warning，不抛（不能把压缩回滚）", async () => {
    stub({ ok: false, error: "日志库只读" });
    await expect(recordCompaction("t-1", { tokensBefore: 10, tokensAfter: 2 })).resolves.toBeUndefined();
  });

  it("没有通道时也不抛", async () => {
    (globalThis as { shell?: unknown }).shell = {} as ShellBridge;
    await expect(recordCompaction("t-1", { tokensBefore: 10, tokensAfter: 2 })).resolves.toBeUndefined();
  });
});
