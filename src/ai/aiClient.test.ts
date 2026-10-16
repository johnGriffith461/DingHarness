import { afterEach, describe, expect, it, vi } from "vitest";
import { listProviders, probeProviders, streamChat } from "./aiClient";

/**
 * `src/ai/aiClient.ts` 的四条（2026-10-16，审计 P238 / P239 / P240）。
 *
 * 为什么这三条要一起测：它们都是**"失败被吞掉、界面与真失败长得一样"**那一族 ——
 * 报错不响、界面照常渲染，用户看到的是"没什么反应"。这类只能靠断言钉住。
 *
 * 每条判据都做过**变异实证**（把修复退回去，看它是不是真变红），结果写在各用例上面。
 */

type AnyShell = { shell?: unknown };

function setShell(value: unknown): void {
  (globalThis as unknown as AnyShell).shell = value;
}
/** 造一个只有 `ai` 那一段的假桥（够这些用例用，不去拼完整的 ShellBridge）。 */
function aiShell(ai: Record<string, unknown>): unknown {
  return { ai };
}

afterEach(() => {
  delete (globalThis as AnyShell).shell;
  vi.restoreAllMocks();
});

describe("AI 通道封装：失败不许被吞成「没事」（P238 / P240）", () => {
  it("⭐ 没桥时说的是「不在 Electron 里」；**有桥但读失败**说的是「读不到」，不是让人去起 Electron", async () => {
    /* ── 变异实证：把 catch 改回 `return BROWSER_PROVIDERS`（即 P238 的旧行为）→ 本用例红 ── */
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // ① 没桥：那句"请用 Electron 启动"是正确的指引
    setShell(undefined);
    const noBridge = await listProviders();
    expect(noBridge).toHaveLength(1);
    expect(noBridge[0].available).toBe(false);
    expect(noBridge[0].note ?? "").toContain("Electron");

    // ② 有桥但读失败：指引必须**换掉** —— 他本来就在 Electron 里
    setShell(
      aiShell({
        listProviders: async () => {
          throw new Error("凭据文件读失败");
        },
      }),
    );
    const failed = await listProviders();
    expect(failed).toHaveLength(1);
    expect(failed[0].available).toBe(false);
    expect(failed[0].label, "这一条要自报「读不到」，而不是冒充一家 provider").toContain("读不到");
    const note = failed[0].note ?? "";
    expect(note, "读失败时的文案不许再把用户往「去起 Electron」上带").not.toContain("dev:app");
    expect(note).not.toContain("请用 pnpm");
    // 原文不许吐到界面（界面只给"读不到"），但要落日志
    expect(note).not.toContain("凭据文件读失败");
    expect(err).toHaveBeenCalled();

    // ③ 失败那条不许被当成可用通道（否则路由会挑中一个坏通道）
    expect(failed[0].id).not.toBe(noBridge[0].id);
  });

  it("⭐ 探测失败与「探测跑了但一条都没成」必须分得开（P240）", async () => {
    /* ── 变异实证：把返回值改回"异常 → `[]`"（P240 旧行为）→ 第二个 expect 红 ── */
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

    setShell(
      aiShell({
        probe: async () => {
          throw new Error("主进程探测段异常");
        },
      }),
    );
    const failed = await probeProviders();
    expect(failed.rows).toEqual([]);
    expect(failed.error, "「没跑成」必须带得出来，否则界面与「没结果」一样").toBeTruthy();
    expect(err).toHaveBeenCalled();

    // 正常那条：有结果、且没有 error
    setShell(aiShell({ probe: async () => [{ id: "p1", ok: true, ms: 12 }] }));
    const ok = await probeProviders();
    expect(ok.rows).toEqual([{ id: "p1", ok: true, ms: 12 }]);
    expect(ok.error).toBeUndefined();

    // 没桥也说得清
    setShell(undefined);
    const noBridge = await probeProviders();
    expect(noBridge.rows).toEqual([]);
    expect(noBridge.error ?? "").toContain("Electron");
  });
});

describe("AI 流的空闲看门狗（P239）", () => {
  /** 起一条**永不收尾**的流：主进程收了请求、给了 requestId，然后一个事件都不再发。 */
  function hungShell(abort: (id: string) => Promise<{ ok: boolean }>) {
    return aiShell({
      chat: async () => ({ requestId: "r1", ok: true }),
      onStream: () => () => undefined,
      abort,
    });
  }

  it("⭐ 上游静默时必须以「可读的失败」收尾，而不是永久停在生成中", async () => {
    /*
     * ── 变异实证（形态是**挂死**，不是断言失败）──
     * 把看门狗那几行退回（即 P239 的旧行为）→ 这里的 `await handle.done` **永远不 resolve**，
     * 用例只能被 vitest 的超时杀掉 (=红)。这正是产品里那个"用户只能强杀应用"的形状。
     */
    const abort = vi.fn(async () => ({ ok: true }));
    setShell(hungShell(abort));

    const events: Array<{ type: string; message?: string }> = [];
    const handle = await streamChat(
      { provider: "p1", model: "m1", messages: [] },
      (e) => events.push({ type: e.type, message: "message" in e ? e.message : undefined }),
      { idleTimeoutMs: 40 },
    );

    const result = await handle.done;
    expect(result.aborted, "这不是用户中止，不能标成 aborted").toBe(false);

    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect(last?.message ?? "").toContain("没有回任何数据");
    expect(abort, "看门狗要尽力真的去中止主进程那一轮").toHaveBeenCalledWith("r1");
  });

  it("只要事件还在来，看门狗就不许误杀（每次事件都会复位）", async () => {
    /* ── 变异实证：把 `dispatch` 里的 `armWatchdog()` 去掉 → 本用例红（长流被 40ms 砍掉）── */
    let emit: ((e: unknown) => void) | undefined;
    setShell(
      aiShell({
        chat: async () => ({ requestId: "r2", ok: true }),
        onStream: (cb: (e: unknown) => void) => {
          emit = cb;
          return () => undefined;
        },
        abort: async () => ({ ok: true }),
      }),
    );

    const errors: string[] = [];
    const handle = await streamChat(
      { provider: "p1", model: "m1", messages: [] },
      (e) => {
        if (e.type === "error") errors.push(e.message);
      },
      { idleTimeoutMs: 40 },
    );

    // 每 12ms 来一个增量，连着 5 次（总共 60ms > 40ms 的空闲阈值）
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 12));
      emit?.({ requestId: "r2", type: "text", text: `第${i}段` });
    }
    emit?.({ requestId: "r2", type: "done" });

    const result = await handle.done;
    expect(errors, "事件在流就不该判超时").toEqual([]);
    expect(result.aborted).toBe(false);
  });
});
