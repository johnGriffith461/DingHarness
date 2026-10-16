import { describe, expect, it } from "vitest";

import { FOLLOW_EPSILON, createFollowLoop, nextToolbarPos } from "./toolbarFollow";

/**
 * 守卫：**静止时不该有帧**（2026-10-16，审计 P71）。
 *
 * 修前实测的写法是：`TextToolbar` 里无条件 `requestAnimationFrame(follow)` 自续，
 * 每帧 `querySelector` + `getBoundingClientRect()`（强制布局）+ `setPos({...})`（新对象 → 重渲染）——
 * 一块不动的界面常年 60fps。这一组用例把"帧只在有人动的时候才排"钉住。
 */
describe("浮动工具条的跟随（P71）", () => {
  it("位置没变就返回**原来那个对象**（引用相等 → React 跳过重渲染）", () => {
    const prev = { left: 100, top: 50 };
    const same = nextToolbarPos(prev, { left: 100 - 30, top: 50, width: 60 }); // 中心 100，顶 50
    expect(same, "差 0 像素也 setState 的话，静止渲染就白跑").toBe(prev);
    const tiny = nextToolbarPos(prev, { left: 100 - 30 + 0.2, top: 50 - 0.2, width: 60 });
    expect(tiny, `小于阈值（${FOLLOW_EPSILON}px）也算没动`).toBe(prev);
  });

  it("真的动了就返回新位置", () => {
    const prev = { left: 100, top: 50 };
    const moved = nextToolbarPos(prev, { left: 100 - 30 + 12, top: 50 + 8, width: 60 });
    expect(moved).not.toBe(prev);
    expect(moved).toEqual({ left: 112, top: 58 });
  });

  it("⭐ 没人动的时候一帧都不排（这就是 P71 要的那个性质）", () => {
    let measured = 0;
    const loop = createFollowLoop({ measure: () => (measured += 1) !== 0, raf: () => 1, caf: () => undefined });
    expect(loop.frames(), "刚建出来还没人动，不该有帧").toBe(0);
    expect(loop.pending(), "也不该排着帧").toBe(false);
    expect(measured).toBe(0);
  });

  it("指针按下期间一直跟，松手之后一小段就停", () => {
    let clock = 0;
    const queue: Array<() => void> = [];
    const loop = createFollowLoop({
      measure: () => true,
      raf: (cb) => {
        queue.push(cb);
        return queue.length;
      },
      caf: () => undefined,
      now: () => clock,
      tailMs: 250,
    });

    loop.pointerDown();
    expect(queue.length, "按下之后要排上第一帧").toBe(1);
    for (let i = 0; i < 5; i += 1) {
      clock += 16;
      queue.shift()?.();
    }
    expect(loop.frames(), "按下期间持续跟（这里跑了 5 帧）").toBe(5);
    expect(loop.pending(), "还在按下 → 还要继续排").toBe(true);

    loop.pointerUp();
    clock += 16;
    queue.shift()?.();
    const framesAfterRelease = loop.frames();
    clock += 300; // 超过尾巴
    queue.shift()?.();
    expect(loop.frames(), "尾巴之后再加一帧就收手").toBe(framesAfterRelease + 1);
    expect(loop.pending(), "松手 + 尾巴走完 → 不再排帧（回到静止）").toBe(false);
  });

  it("滚轮 / 缩放那类只在事件之后跟一小段", () => {
    let clock = 0;
    const queue: Array<() => void> = [];
    const loop = createFollowLoop({
      measure: () => true,
      raf: (cb) => {
        queue.push(cb);
        return queue.length;
      },
      caf: () => undefined,
      now: () => clock,
    });
    loop.burst(600);
    expect(queue.length).toBe(1);
    clock += 16;
    queue.shift()?.();
    expect(loop.pending(), "尾巴里继续跟着").toBe(true);
    clock += 1000;
    queue.shift()?.();
    expect(loop.pending(), "尾巴过了就停").toBe(false);
  });

  it("卸载（stop）之后彻底不动：排着的帧会被取消", () => {
    let cancelled = 0;
    const queue: Array<() => void> = [];
    const loop = createFollowLoop({
      measure: () => true,
      raf: (cb) => {
        queue.push(cb);
        return queue.length;
      },
      caf: () => {
        cancelled += 1;
      },
    });
    loop.pointerDown();
    loop.stop();
    expect(cancelled, "卸载时要 cancelAnimationFrame").toBe(1);
    expect(loop.pending()).toBe(false);
    queue.shift()?.();
    expect(loop.frames(), "stop 之后就算回调被迟到了也不该再跑").toBe(0);
  });
});
