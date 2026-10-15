import { describe, expect, it } from "vitest";

import { resolveServePort } from "./cmdServe";

/**
 * `ding serve --port` 的取值判定（2026-10-16，审计 P111）。
 *
 * 原来的形状是 `Number(flag(p, "port") ?? 8787)`：
 * `--port`（漏值，`parseArgv` 回填 `"true"`）或 `--port -1`（`-1` 被当新旗标）
 * 都会静默变成 `NaN` 喂给 `listen`。同类形状在生产里是"参数好像没生效"那种错，
 * 在这里还给不出那句人话。这条判定就是那句人话。
 */

describe("resolveServePort", () => {
  it("不给 --port：默认 8787", () => {
    expect(resolveServePort(undefined)).toEqual({ ok: true, port: 8787 });
  });

  it("正常值直接过（含 0 = 系统分配随机端口）", () => {
    expect(resolveServePort("8787")).toEqual({ ok: true, port: 8787 });
    expect(resolveServePort("0")).toEqual({ ok: true, port: 0 });
    expect(resolveServePort("65535")).toEqual({ ok: true, port: 65535 });
  });

  it("⭐ 漏值（`parseArgv` 回填的 `\"true\"`）报错，不再变 NaN", () => {
    const got = resolveServePort("true");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.message).toContain("整数");
  });

  it("⭐ 负数 / 超出范围 / 不是数字：都报错", () => {
    expect(resolveServePort("-1").ok).toBe(false);
    expect(resolveServePort("70000").ok).toBe(false);
    expect(resolveServePort("八七八七").ok).toBe(false);
    expect(resolveServePort("87.87").ok).toBe(false);
  });
});
