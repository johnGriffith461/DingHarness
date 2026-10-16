/**
 * 把两组指针事件处理**合并**成一份（同名键**按顺序都调用**，不是让后面的盖掉前面的）。
 *
 * ## 为什么要它（2026-10-16，审计 P69）
 *
 * 画布根节点上原来是这样展开的：
 *
 * ```tsx
 * {...selection.handlers}
 * {...markerDraw.handlers}
 * ```
 *
 * 两份 `handlers` 都带 `onPointerMove` / `onPointerUp` / `onPointerCancel` ——
 * 对象展开**同键就是覆盖**，于是 markerDraw 那三个把 selection 的顶掉了。
 * 后果：**框选与涂抹整体失效**（selection 的 `sweep()` 与 `end()` 永不执行），
 * 而"点了没反应"这种毛病在界面上一点也不显眼 —— 它只是什么都不发生。
 *
 * 这类 bug 的形状值得记住：**两份配置往同一个元素上铺，谁后铺谁说话**。
 * 所以修法不是"换一下顺序"（那只是让另一件事坏掉），而是让两份都真的跑：
 * 同名键合成一个函数，按传入顺序依次调用。
 *
 * ## 契约
 *
 * · 只有一边有的键：原样保留（引用不变）；
 * · 两边都有的键：先 `first` 后 `second`，**同一个事件对象**、返回值取 `second` 的
 *   （DOM 的 handler 返回值除了 `false` 之外没人看，这里不做特殊处理）；
 * · 两边的异常互不吞掉（谁抛就抛出去 —— 吞掉会让"哪一半坏了"永远查不出来）。
 *
 * @param first 先跑的一组（这里是「框选」）
 * @param second 后跑的一组（这里是「涂抹 / 标记」）
 * @returns 合并后的 handlers
 */
export function mergeHandlers<A extends Record<string, unknown>, B extends Record<string, unknown>>(
  first: A,
  second: B,
): A & B {
  const out: Record<string, unknown> = { ...first };
  for (const [key, secondHandler] of Object.entries(second)) {
    const firstHandler = out[key];
    if (typeof firstHandler !== "function" || typeof secondHandler !== "function") {
      out[key] = secondHandler;
      continue;
    }
    out[key] = (...args: unknown[]) => {
      (firstHandler as (...a: unknown[]) => unknown)(...args);
      return (secondHandler as (...a: unknown[]) => unknown)(...args);
    };
  }
  return out as A & B;
}
