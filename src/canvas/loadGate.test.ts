import { describe, expect, it } from "vitest";

import { markCanvasLoaded, resetCanvasLoadGate, waitCanvasLoaded } from "./loadGate";

/**
 * P74 的画布载入闸。
 *
 * 2026-10-20（accept-tools 实测）：`waitCanvasLoaded` 先抓住当时的 Promise，
 * 而画布**挂载**发生在命令到达之后 —— `resetCanvasLoadGate()` 把 Promise 换掉，
 * 等待方抱着旧那个永远等不到，15 秒后错误地报"画布没载入完"（画布其实已经显示 6 个节点）。
 */
describe("画布载入闸", () => {
  it("等待方在 reset 之前开始，也能被随后那次 mark 放行（命令先到、画布后挂载）", async () => {
    resetCanvasLoadGate();
    const waiting = waitCanvasLoaded(1000);
    /* 画布此刻才挂载 */
    resetCanvasLoadGate();
    markCanvasLoaded();
    await expect(waiting).resolves.toBe(true);
  });

  it("超时如实返回 false", async () => {
    resetCanvasLoadGate();
    await expect(waitCanvasLoaded(30)).resolves.toBe(false);
  });

  it("已经载入过 → 下一次等待立即放行", async () => {
    resetCanvasLoadGate();
    markCanvasLoaded();
    await expect(waitCanvasLoaded(30)).resolves.toBe(true);
  });

  it("reset 之后必须重新等（不能拿上一次的'已载入'糊弄）", async () => {
    resetCanvasLoadGate();
    markCanvasLoaded();
    resetCanvasLoadGate();
    await expect(waitCanvasLoaded(30)).resolves.toBe(false);
  });
});
