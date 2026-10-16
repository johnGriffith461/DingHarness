/**
 * 「等若干帧」的兜底（2026-10-16 审计 P75）。
 *
 * ## 为什么要兜底
 *
 * 导出 PNG 前要先把浮层藏起来、等两帧让合成完成再截屏。原来那个等待是：
 *
 * ```ts
 * await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
 * ```
 *
 * 而 `requestAnimationFrame` **只在窗口可见时才回调**：主人在导出时把窗口切到后台、
 * 或窗口被别的应用整个盖住（这台机器上还叠加了最小化），这个 await 就**永远不返回** ——
 * 后面的 `finally { setExporting(false) }` 走不到，于是浮层**永远停在隐藏态**：
 * 用户看到的是"点了导出，工具栏和面板全没了，怎么点都不回来"。
 *
 * 帧数与超时都得有上限，所以抽成这个函数：它**一定会 settle**，
 * 返回"到底等到了还是超时了"（调用方据此决定要不要继续）。
 */

/** 一帧的调度器（浏览器里就是 `requestAnimationFrame`）。 */
export type FrameScheduler = (callback: () => void) => number;

/** 定时器（测试里可以换成假的）。 */
export type Timer = (callback: () => void, ms: number) => unknown;

/**
 * 等 `frames` 帧，但**最多**等 `timeoutMs`。
 *
 * @param frames 想等的帧数（≥1）
 * @param raf 帧调度器
 * @param timeoutMs 上限；到点就返回 false（别让调用方永远挂着）
 * @param setTimer 挂超时定时器（默认 `setTimeout`）
 * @returns true = 帧真的等到了；false = 超时了
 */
export function waitFramesOrTimeout(
  frames: number,
  raf: FrameScheduler,
  timeoutMs: number,
  setTimer: Timer = (cb, ms) => setTimeout(cb, ms),
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let left = Math.max(0, Math.floor(frames));

    const finish = (waited: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(waited);
    };

    /* 先挂超时：哪怕一帧都不来，这个 Promise 也一定会 settle */
    setTimer(() => finish(false), timeoutMs);

    const step = (): void => {
      if (settled) return;
      left -= 1;
      if (left <= 0) finish(true);
      else raf(step);
    };

    if (left <= 0) finish(true);
    else raf(step);
  });
}
