import { useEffect, useState } from "react";
import type { ShellBridge } from "@shared/ipc";

/**
 * 自绘窗口控制条（最小化 / 最大化·还原 / 关闭）。
 *
 * ## 为什么它存在（2026-10-15，M0 工单 1）
 *
 * 之前右上角那三个按钮是 `titleBarOverlay` 让 **Windows 原生画的**。
 * 那套按钮位置固定（右上角约 138×36 DIP），而本应用的「云盘 / 插件·技能·伙伴 /
 * 定时任务」三个视图把自己的操作按钮也放在右上角（`wb-cloud-new` 等，
 * x=1359..1426）—— 于是原生按钮正好压在它们上面，用户看到"按钮重复显示"。
 * 根因与证据：`electron/ipc/windowControls.ts`、`.verify/m0/repro-cloud-topright.png`。
 *
 * ## 为什么它是 `.wb` 的第一个孩子、并且独占一行
 *
 * 它同时是窗口的**拖动区**（`titleBarStyle: "hidden"` 之后没有系统标题栏，
 * 拖动只能靠 CSS 的 `-webkit-app-region: drag`）。拖动区会吃掉落在它底下的点击，
 * 所以 `.wb` 用 `padding-top` 把内容整体下移一条标题栏的高度 —— 它底下永远是空的。
 * 这不是排版口味，是"别让拖拽区吞掉按钮点击"（`FloatingAssistant.tsx:52` 的教训）。
 */

const bridge = (): ShellBridge | undefined => (globalThis as unknown as { shell?: ShellBridge }).shell;

/** 字形统一 10×10 细线，与系统 caption 按钮同一观感。 */
function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
      {children}
    </svg>
  );
}

export default function TitleBar() {
  /*
   * 初值给 false，装上之后再问主进程 —— 不要在渲染期同步读
   * （首帧读到什么都会闪一下；而这里的状态变化还会由主进程推过来）。
   */
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = bridge()?.win;
    if (!win) return;
    let alive = true;
    void win
      .isMaximized()
      .then((v) => {
        if (alive) setMaximized(v);
      })
      .catch(() => {
        /* 拿不到就按"没最大化"画：图标错一次，不该把标题栏整个弄崩 */
      });
    /*
     * 订阅而不是只在点击时更新：用户还会**双击标题栏 / Win+↑ / 拖到屏幕边缘 Snap**
     * ——那些都不经过我们的按钮，不订阅的话图标会一直停在旧状态。
     */
    const off = win.onMaximizedChange(setMaximized);
    return () => {
      alive = false;
      off();
    };
  }, []);

  return (
    /* 双击标题栏 = 最大化 ⇄ 还原（Windows 惯例；拖动区里的双击系统也会自己处理一次） */
    <div
      className="wb-titlebar"
      data-testid="wb-titlebar"
      onDoubleClick={() => {
        void bridge()?.win?.toggleMaximize();
      }}
    >
      <div className="wb-winctl" data-testid="wb-winctl">
        <button
          type="button"
          aria-label="最小化"
          title="最小化"
          data-testid="wb-win-min"
          onClick={() => void bridge()?.win?.minimize()}
        >
          <Glyph>
            <path d="M0.5 5h9" />
          </Glyph>
        </button>
        {/* 最大化与还原是**同一个键**，图标跟着真实状态走 */}
        <button
          type="button"
          aria-label={maximized ? "向下还原" : "最大化"}
          title={maximized ? "向下还原" : "最大化"}
          data-testid="wb-win-max"
          data-maximized={maximized ? "true" : "false"}
          onClick={() => {
            void bridge()
              ?.win?.toggleMaximize()
              .then(setMaximized)
              .catch(() => {
                /* 主进程没答就保持原状，别猜 */
              });
          }}
        >
          {maximized ? (
            <Glyph>
              <path d="M0.5 7.5V0.5H7.5" />
              <path d="M2.5 2.5h7v7h-7z" />
            </Glyph>
          ) : (
            <Glyph>
              <path d="M0.5 0.5h9v9h-9z" />
            </Glyph>
          )}
        </button>
        <button
          type="button"
          className="is-close"
          aria-label="关闭"
          title="关闭"
          data-testid="wb-win-close"
          onClick={() => void bridge()?.win?.close()}
        >
          <Glyph>
            <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
          </Glyph>
        </button>
      </div>
    </div>
  );
}
