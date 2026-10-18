import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ShellBridge } from "@shared/ipc";
import { exportDiagnosticsPackage } from "./feedbackExport";
import { trapTabKey } from "./focusTrap";

/**
 * **诊断包预览**（G17 的"用户可预览内容"）。
 *
 * ## 为什么要预览
 *
 * 诊断包是要贴给别人的文件。让用户在**导出之前**看到全文，是"本地主权"这条承诺的
 * 直接推论：我不替你决定什么能发出去。预览与导出调的是主进程**同一个组装函数**，
 * 所以看到的就是要写盘的（不是另拼一份）。
 *
 * ## 三条边界写在界面上
 *
 * 1. 不含密钥值（`shared/redact.ts` 整包脱敏 + 凭据那格只报 id）；
 * 2. 最近事件只有类型/工具名/成败，**不含对话正文**；
 * 3. 不上报任何东西 —— 文件只落在本机，由用户自己决定给谁。
 */

function shell(): ShellBridge | null {
  return (globalThis as { shell?: ShellBridge }).shell ?? null;
}

/** 打开预览的事件名（与 `dsh-open-settings` 同一套做法：命令面板/反馈按钮都用它）。 */
export const OPEN_DIAGNOSTICS_EVENT = "dsh-open-diagnostics";

export function requestDiagnosticsPreview(): void {
  window.dispatchEvent(new CustomEvent(OPEN_DIAGNOSTICS_EVENT));
}

export function DiagnosticsDialog() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ json: string; bytes: number; note: string } | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_DIAGNOSTICS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_DIAGNOSTICS_EVENT, onOpen);
  }, []);

  /* 打开就取一次预览（与导出同一份组装） */
  useEffect(() => {
    if (!open) return;
    setState(null);
    setError("");
    setNote("");
    const api = shell();
    if (typeof api?.diagnostics?.preview !== "function") {
      setError("预览需要在应用里运行（当前环境没有主进程）");
      return;
    }
    void api.diagnostics
      .preview()
      .then((got) => {
        if (got.ok) setState({ json: got.json, bytes: got.bytes, note: got.note });
        else setError(got.error);
      })
      .catch((e: unknown) => setError(`预览失败：${e instanceof Error ? e.message : String(e)}`));
  }, [open]);

  /* 键盘：Esc 关、Tab 在内部循环、关闭归还焦点（与设置浮层同一套判定） */
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      trapTabKey(e, panelRef.current);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (previous && previous !== document.body && document.contains(previous)) previous.focus();
      else document.querySelector<HTMLElement>('[data-testid="wb-nav-home"]')?.focus();
    };
  }, [open]);

  if (!open) return null;

  const doExport = async (): Promise<void> => {
    const got = await exportDiagnosticsPackage();
    setNote(got.message);
  };

  return createPortal(
    <div
      className="wb-setfull"
      data-testid="wb-diagnostics"
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="诊断包预览"
    >
      <div className="wb-setfull-bar">
        <button
          className="wb-setfull-back"
          data-testid="wb-diagnostics-close"
          onClick={() => setOpen(false)}
          aria-label="关闭预览"
          title="关闭预览"
        >
          ‹ 关闭
        </button>
        <b>诊断包预览</b>
        <span className="wb-spacer" />
      </div>
      <div className="wb-setpage-body" data-testid="wb-diagnostics-body">
        <div className="wb-setpage-note" data-testid="wb-diagnostics-note">
          {state?.note ?? "正在组装（自检项 + 版本 + 路径 + 最近事件）…"}
        </div>
        {error ? (
          <div className="wb-setpage-note" role="alert" data-testid="wb-diagnostics-error">
            没组装成：{error}
          </div>
        ) : null}
        {state ? (
          <>
            <div className="wb-setpage-row">
              <span className="wb-setpage-label">内容</span>
              <em data-testid="wb-diagnostics-size">{`${state.bytes} 字节（已脱敏）`}</em>
            </div>
            <pre
              className="wb-setpage-body"
              data-testid="wb-diagnostics-json"
              style={{ maxHeight: "52vh", overflow: "auto", whiteSpace: "pre-wrap", fontSize: 12 }}
            >
              {state.json}
            </pre>
            <div className="wb-setpage-row">
              <span className="wb-setpage-label">导出</span>
              <button className="wb-setpage-btn" data-testid="wb-diagnostics-export" onClick={() => void doExport()}>
                确认无误，导出到本机
              </button>
            </div>
            <div className="wb-setpage-note">
              文件只落在本机（数据目录下的 diagnostics/）；本程序不会自动上报任何东西。
            </div>
          </>
        ) : null}
        {note ? (
          <div className="wb-setpage-note" role="status" data-testid="wb-diagnostics-result">
            {note}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
