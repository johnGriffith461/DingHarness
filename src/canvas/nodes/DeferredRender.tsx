import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 入视口再渲染（HANDOFF §6.3：Mermaid / markmap / 大代码块必须懒加载）。
 *
 * React Flow 的 `onlyRenderVisibleElements` 只保证视口外的节点不渲染；
 * 节点一旦进入视口，它的重型内容（绘图库、上千行代码）仍会立刻执行。
 * 这里再收一道：内容真正滚进视口、且静置一小段时间后才去渲染，
 * 拖动/缩放过程中只显示占位，避免掉帧。
 *
 * ⚠️ 一个踩过的坑：`resetKey` 变化时必须**重新建观察器**。
 * 早期版本把 `setReady(false)` 和观察器分成两个 effect，观察器只依赖
 * `[delayMs, rootMargin]` —— 于是内容变了、`ready` 被置回 false，
 * 但**没有新的交叉回调**（IntersectionObserver 只在交叉状态*变化*时回调，
 * 节点一直可见就不会再触发），内容就永远停在骨架屏上。
 * 表现是"AI 改写/重生成之后节点变成空架子，怎么等都不回来"。
 * 所以这里把重置和观察合进同一个 effect，并把 `resetKey` 放进依赖 ——
 * `observe()` 会立即用当前交叉状态回调一次，骨架屏只多停留 `delayMs`。
 */

export type DeferredRenderProps = {
  /** 占位内容（默认一个轻量骨架）。 */
  placeholder?: ReactNode;
  /** 入视口后延迟多少毫秒才渲染，用来避开"快速划过"。 */
  delayMs?: number;
  /** 触发渲染的判定余量（提前多少像素开始渲染）。 */
  rootMargin?: string;
  /** 依赖变化时强制重新判定（例如内容源换了）。 */
  resetKey?: string;
  children: ReactNode;
};

export default function DeferredRender({
  placeholder = <div className="nv-skeleton" />,
  delayMs = 60,
  rootMargin = "160px",
  resetKey,
  children,
}: DeferredRenderProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    setReady(false);
    if (!host) return;

    if (typeof IntersectionObserver === "undefined") {
      setReady(true);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (entry.isIntersecting) {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => setReady(true), delayMs);
        } else if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
      { rootMargin },
    );
    observer.observe(host);

    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
    // resetKey 参与依赖：内容换了要重新判定（见文件头的坑）
  }, [delayMs, rootMargin, resetKey]);

  return (
    <div className="nv-deferred" ref={hostRef}>
      {ready ? children : placeholder}
    </div>
  );
}
