import { useEffect } from "react";

/**
 * 通用浮层菜单（阶段 11.18）。
 *
 * 原来只有云盘行有右键菜单，实现写在 `pages.tsx` 里。左栏的行也需要一个
 * （实机是**悬停露出的 ⋯**，不是右键），所以把它抽出来共用。
 *
 * 关掉的时机有几处是必须的，少一个都会留下"压着界面不走的菜单"：
 * 点别处、按 Esc、**滚动**（滚动时菜单还留在原地就指错行了）。
 */

/** 菜单项。 */
export type MenuItem = {
  label: string;
  icon?: string;
  /** 禁用时的原因（同时作为 tooltip）。给了就不响应点击。 */
  disabled?: string;
  run?: () => void;
};

/**
 * 在指定坐标弹出一个菜单。
 *
 * @param props.items 菜单项
 * @param props.x 视口 x
 * @param props.y 视口 y
 * @param props.onClose 关闭回调
 * @param props.testid 容器的 data-testid
 */
export default function ContextMenu({
  items,
  x,
  y,
  onClose,
  testid = "wb-menu",
}: {
  items: MenuItem[];
  x: number;
  y: number;
  onClose: () => void;
  testid?: string;
}) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // mousedown 而不是 click：点下去就关，避免"点到了底下的行还顺手触发了它"
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [onClose]);

  return (
    <div
      className="wb-ctx"
      data-testid={testid}
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          className={`wb-ctx-item${item.disabled ? " is-off" : ""}`}
          data-testid={`${testid}-${item.label}`}
          title={item.disabled ?? ""}
          disabled={Boolean(item.disabled)}
          onClick={() => {
            item.run?.();
            onClose();
          }}
        >
          {item.icon ? <span className="wb-ctx-icon">{item.icon}</span> : null}
          {item.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 把菜单夹进视口。
 *
 * 不夹的话，靠右下角弹的菜单会跑出窗口 —— 用户看不到最后几项，
 * 而且会以为"菜单就这几个"。
 *
 * @param x 期望的 x
 * @param y 期望的 y
 * @param width 菜单预估宽度
 * @param height 菜单预估高度
 * @returns 夹好之后的坐标
 */
export function clampMenu(x: number, y: number, width = 190, height = 240): { x: number; y: number } {
  return {
    x: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
    y: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
  };
}
