/**
 * 浮动工具条的跟随逻辑（2026-10-16，审计 P71）。
 *
 * ## 原来错在哪
 *
 * `TextToolbar` 里是这么写的：无条件 `requestAnimationFrame(follow)` 自续，
 * 每帧 `document.querySelector` + `getBoundingClientRect()`（**强制布局**）
 * 再 `setPos({...})`（**每帧一个新对象 → 必然重渲染**）。
 * 于是一块静止不动的界面也常年 60fps：笔记本上电池白耗、风扇白转，
 * 而这一切只为了一件事 —— "节点被拖动/画布被平移时面板跟着走"。
 *
 * ## 现在怎么判
 *
 *   ① **位置没变就不 `setPos`**：新位置与旧位置的差都小于阈值（默认 0.5px）时
 *      返回**原来那个对象**（引用不变 = React 直接跳过重渲染）；
 *   ② **没人动的时候一帧都不排**：只有"指针按下期间"与"事件之后的一小段尾巴"
 *      才跑帧循环（滚轮/缩放/尺寸变化用短尾巴盖住动画过程）。
 *
 * 这两条都在这个文件里，且都写成**可测的纯逻辑** —— 因为"静止时不该有帧"
 * 这种事靠读代码是看不出来的，得有个东西在测试里数帧。
 */

export type ToolbarPos = { left: number; top: number };
export type RectLike = { left: number; top: number; width: number };

/** 位置变化的阈值（像素）：小于它就算"没动"。 */
export const FOLLOW_EPSILON = 0.5;

/**
 * 由节点矩形算出面板位置；**没动就返回原来那个对象**（引用相等 → 不触发重渲染）。
 *
 * @param prev 上一次的位置（null = 还没定过位）
 * @param rect 节点元素的实际矩形
 * @param epsilon 变化阈值
 * @returns 位置（未变时就是 `prev`）
 */
export function nextToolbarPos(prev: ToolbarPos | null, rect: RectLike, epsilon = FOLLOW_EPSILON): ToolbarPos {
  const next = { left: rect.left + rect.width / 2, top: rect.top };
  if (!prev) return next;
  if (Math.abs(prev.left - next.left) < epsilon && Math.abs(prev.top - next.top) < epsilon) return prev;
  return next;
}

export type FollowLoopOptions = {
  /** 每次要量一次位置（返回 true = 量到了）。 */
  measure: () => boolean;
  /** 排一帧（默认 `requestAnimationFrame`；测试里注入假的）。 */
  raf?: (cb: () => void) => number;
  /** 取消一帧（默认 `cancelAnimationFrame`）。 */
  caf?: (handle: number) => void;
  /** 现在几点（默认 `performance.now()`；测试里注入假的）。 */
  now?: () => number;
  /** 松手之后还要跟多久（默认 250ms：盖住"松手那一刻的最终落位"）。 */
  tailMs?: number;
};

/**
 * 一个**只在有人动的时候才跑**的跟随循环。
 *
 * 用法：`loop.pointerDown()` 在按下时调、`loop.pointerUp()` 在松开时调、
 * `loop.burst(600)` 在滚轮/缩放/尺寸变化时调（跑一小段尾巴就停）。
 * 不动的时候 `frames()` 不涨 —— 这正是 P71 要钉住的那件事。
 */
export function createFollowLoop(options: FollowLoopOptions) {
  const raf = options.raf ?? ((cb: () => void) => requestAnimationFrame(cb));
  const caf = options.caf ?? ((handle: number) => cancelAnimationFrame(handle));
  const now = options.now ?? (() => performance.now());
  const tailMs = options.tailMs ?? 250;

  let handle: number | null = null;
  let pointerDown = false;
  let tailUntil = 0;
  let frames = 0;
  let stopped = false;

  const tick = () => {
    handle = null;
    if (stopped) return;
    frames += 1;
    options.measure();
    if (pointerDown || now() < tailUntil) schedule();
  };

  const schedule = () => {
    if (handle !== null || stopped) return;
    handle = raf(tick);
  };

  return {
    /** 指针按下：一直跟到松手。 */
    pointerDown() {
      pointerDown = true;
      schedule();
    },
    /** 松手：再跟一小段（收尾那次落位），然后停。 */
    pointerUp() {
      pointerDown = false;
      tailUntil = Math.max(tailUntil, now() + tailMs);
      schedule();
    },
    /** 滚轮 / 缩放 / 尺寸变化：跟一小段就停。 */
    burst(ms = 600) {
      tailUntil = Math.max(tailUntil, now() + ms);
      schedule();
    },
    /** 彻底停（卸载时调）。 */
    stop() {
      stopped = true;
      pointerDown = false;
      tailUntil = 0;
      if (handle !== null) {
        caf(handle);
        handle = null;
      }
    },
    /** 已经跑了几帧（测试用；也方便在排查时打日志）。 */
    frames: () => frames,
    /** 现在排着帧吗。 */
    pending: () => handle !== null,
  };
}
