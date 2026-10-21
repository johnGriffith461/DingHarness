import { useEffect, useRef } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";

/**
 * **应用内确认框**（2026-10-19，主人点名）。
 *
 * ## 为什么不用系统原生弹窗
 *
 * 原来 CUA 的授权与每次动作确认走 `dialog.showMessageBox` —— 那是**操作系统画的窗口**
 * （Windows 上是老式蓝标题栏 + 系统图标），与 Ding 自己的界面不在一个世界里。
 * 而且原生弹窗有三个具体问题：样式不可控、截图验收拿不到（不在 DOM 里）、抢焦点。
 *
 * ## 为什么不用 `.wb-setfull`
 *
 * 第一版复用了它，结果**整页被铺成白板**（主人当场截图：一个空白页，内容挤在左上角）。
 * `.wb-setfull` 是「整页设置视图」的样式（`inset:0` + flex 列 + 整块背景），
 * 拿它画居中弹窗等于把整个工作台盖掉。
 *
 * 现在这套 `wb-modal-*` 是**专用**的：
 * - `wb-modal-mask`：半透明遮罩 + `position: fixed`，居中对齐；
 * - `wb-modal-card`：卡片本身，最大宽度 520px，主题变量与卡片一致；
 * - **遮罩不吃点击关闭**：安全确认手滑点空白就关掉是最糟的设计。
 */

export type ConfirmRequest = {
  title: string;
  message: string;
  detail?: string;
  /** 确认按钮文案（要说清会发生什么，不要只写"确定"）。 */
  confirmLabel: string;
  cancelLabel?: string;
  /** 危险动作：用警告图标。 */
  danger?: boolean;
};

export function ConfirmDialog({
  request,
  onAnswer,
}: {
  request: ConfirmRequest;
  onAnswer: (ok: boolean) => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  /* 默认焦点在「取消」：安全闸的默认答案必须是否定的 */
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  /* Esc = 取消。焦点不外逃由外层遮罩的 tab 顺序保证（只有两个按钮）。 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onAnswer(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAnswer]);

  return (
    <div className="wb-modal-mask" data-testid="wb-confirm-dialog">
      <div
        className="wb-modal wb-modal-card"
        role="alertdialog"
        aria-modal="true"
        aria-label={request.title}
        /* 遮罩本来就不吃点击关闭，卡片不需要 stopPropagation —— 也就不该挂 onClick */
      >
        <div className="wb-modal-head">
          {request.danger ? <AlertTriangle size={16} className="wb-modal-icon-warn" /> : <ShieldCheck size={16} />}
          <strong>{request.title}</strong>
        </div>

        <p className="wb-modal-message" data-testid="wb-confirm-message">
          {request.message}
        </p>
        {request.detail ? (
          <p className="wb-modal-detail" data-testid="wb-confirm-detail" style={{ whiteSpace: "pre-line" }}>
            {request.detail}
          </p>
        ) : null}

        <div className="wb-modal-foot">
          <button
            ref={cancelRef}
            className="wb-page-btn"
            data-testid="wb-confirm-cancel"
            onClick={() => onAnswer(false)}
          >
            {request.cancelLabel ?? "取消"}
          </button>
          <button
            className="wb-page-btn wb-page-btn-primary"
            data-testid="wb-confirm-ok"
            onClick={() => onAnswer(true)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
