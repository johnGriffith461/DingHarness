import { describe, expect, it } from "vitest";

import { mergeHandlers } from "./mergeHandlers";

/**
 * 守卫：**两份 handlers 合并之后都要真的跑**（2026-10-16，审计 P69）。
 *
 * 背景：画布根节点上 `{...selection.handlers}` 与 `{...markerDraw.handlers}` 叠着展开，
 * 而同名的 `onPointerMove/onPointerUp/onPointerCancel` 被后者顶掉 ——
 * 夹在中间的那三个键是框选（selection）的命门：**框选与涂抹整体失效**，
 * 界面上只是"点了没反应"。这条用例就是给那一格上的锁。
 */
describe("mergeHandlers：同名键不许互相顶掉", () => {
  it("两边都有的键 → 按顺序都调用（不是后者盖前者）", () => {
    const calls: string[] = [];
    const merged = mergeHandlers(
      { onPointerMove: () => calls.push("selection") },
      { onPointerMove: () => calls.push("marker") },
    );
    merged.onPointerMove();
    expect(calls, "两个 handler 都得跑，而且是先框选后涂抹（与展开顺序一致）").toEqual(["selection", "marker"]);
  });

  it("同一个事件对象给两边（谁也别想改出一个只有自己看得到的副本）", () => {
    const seen: unknown[] = [];
    const event = { pointerId: 7, clientX: 10, clientY: 20 };
    const merged = mergeHandlers(
      { onPointerUp: (e: unknown) => seen.push(["a", e]) },
      { onPointerUp: (e: unknown) => seen.push(["b", e]) },
    );
    merged.onPointerUp(event);
    expect(seen).toEqual([
      ["a", event],
      ["b", event],
    ]);
  });

  it("只有一边有的键原样保留（引用都不换）", () => {
    const onlyFirst = () => "first";
    const onlySecond = () => "second";
    const merged = mergeHandlers({ onPointerDownCapture: onlyFirst }, { onDoubleClick: onlySecond });
    expect(merged.onPointerDownCapture, "单边的键不该被包一层（那会让 identity 判等失效）").toBe(onlyFirst);
    expect(merged.onDoubleClick).toBe(onlySecond);
  });

  it("非函数值不走串联（只保留后者，免得把数字/字符串包成函数）", () => {
    const merged = mergeHandlers({ role: "old" }, { role: "new" });
    expect(merged.role).toBe("new");
  });

  it("一边抛异常，另一边的调用不被吞掉成静默（异常照抛）", () => {
    const calls: string[] = [];
    const merged = mergeHandlers(
      { onPointerMove: () => calls.push("selection") },
      {
        onPointerMove: () => {
          calls.push("marker");
          throw new Error("画到一半炸了");
        },
      },
    );
    expect(() => merged.onPointerMove()).toThrow("画到一半炸了");
    expect(calls, "前半段已经跑过了（异常不许让前半段像个没发生的事）").toEqual(["selection", "marker"]);
  });
});
