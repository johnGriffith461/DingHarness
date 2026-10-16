import { describe, expect, it, vi } from "vitest";
import { waitFramesOrTimeout } from "./frameWait";

/**
 * 导出前"等两帧"必须有上限（2026-10-16 审计 P75）。
 *
 * ## 缺陷形状
 *
 * `requestAnimationFrame` **只在窗口可见时回调**：导出时把窗口切到后台、或窗口被别的应用盖住
 * （这台机器上还叠加了最小化），那个 `await` 就**永远不返回** ——
 * 后面的 `finally { setExporting(false) }` 走不到，浮层**永远停在隐藏态**：
 * 用户看到的是"点了导出，工具栏和面板全没了，怎么点都回不来"。
 *
 * 判据：**窗口不可见时（一帧都不来）这个 Promise 也必须在超时后 settle**。
 */
describe("waitFramesOrTimeout", () => {
  it("⭐ 一帧都不来（窗口被盖住）→ 超时后照样 settle，绝不能永远挂着", async () => {
    vi.useFakeTimers();
    try {
      const raf = vi.fn(); // 从不回调
      const pending = waitFramesOrTimeout(2, raf, 300);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled, "超时之前不该 settle").toBe(false);
      vi.advanceTimersByTime(301);
      await expect(pending).resolves.toBe(false);
      expect(raf, "还是试过排帧的（先排第一帧、没等到才超时）").toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("帧正常回来 → 等够帧数后返回 true（不等超时）", async () => {
    vi.useFakeTimers();
    try {
      const queue: Array<() => void> = [];
      const raf = (cb: () => void) => {
        queue.push(cb);
        return queue.length;
      };
      const pending = waitFramesOrTimeout(2, raf, 5000);
      /* 两帧：第一帧排第二帧，第二帧才算等到 */
      queue.shift()?.();
      queue.shift()?.();
      await expect(pending).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("frames 为 0 时立即返回（不排帧）", async () => {
    const raf = vi.fn();
    await expect(waitFramesOrTimeout(0, raf, 1000)).resolves.toBe(true);
    expect(raf).not.toHaveBeenCalled();
  });
});
