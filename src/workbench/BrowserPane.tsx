import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Globe, RefreshCw, ExternalLink } from "lucide-react";

/**
 * 右栏的**内置浏览器**（2026-10-22，主人：「内置浏览器呢 吃了？」）。
 *
 * ## 为什么是 `<webview>`
 *
 * 右侧面板里要一个**能真的浏览**的东西。三条路各自的问题：
 * - `<iframe>`：绝大多数站点 `X-Frame-Options: DENY`，打开就是空白（现在这一格就是这么空的）；
 * - 主进程 `WebContentsView`：要自己把窗口坐标、缩放、层级同步到渲染层，改一次布局就要对一次账；
 * - `<webview>`：Electron 自带的嵌页标签，能直接写进 React 树。用它。
 *
 * ## 边界（同时写在 SAFETY.md）
 *
 * - 只接受 `http/https`（`normalizeUrl` 里判；`javascript:` / `file:` 一律拒绝）；
 * - 不开 `allowpopups`（网页不许自己弹窗）；
 * - 网页里**拿不到** `window.shell` —— preload 只在主窗口挂，webview 是独立进程与独立上下文。
 *
 * 打不开时的退路：按钮「用系统浏览器打开」仍然可用（不把用户困在空白里）。
 */
const DEFAULT_URL = "https://www.bing.com";

export function normalizeUrl(raw: string): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const withScheme = /^[a-z]+:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function BrowserPane() {
  const [draft, setDraft] = useState(DEFAULT_URL);
  const [url, setUrl] = useState(DEFAULT_URL);
  const [note, setNote] = useState("");
  const viewRef = useRef<HTMLElement | null>(null);

  /* 地址栏回车/点「打开」→ 只跳合法地址 */
  const go = (raw: string): void => {
    const next = normalizeUrl(raw);
    if (!next) {
      setNote("只支持 http/https 地址");
      return;
    }
    setNote("");
    setDraft(next);
    setUrl(next);
  };

  /* 后退/前进/刷新走 webview 自己的 API（拿不到就如实说） */
  const call = (method: "goBack" | "goForward" | "reload"): void => {
    const view = viewRef.current as unknown as Record<string, (() => void) | undefined> | null;
    const fn = view?.[method];
    if (typeof fn !== "function") {
      setNote("这个页面还不能后退/前进");
      return;
    }
    try {
      fn.call(view);
    } catch {
      setNote("操作失败（页面可能还没加载完）");
    }
  };

  /*
   * ⭐ **B-01：把面板这个 webview 交给 agent 工具**（2026-10-22）。
   *
   * 之前 agent 操作的是另一个独立 BrowserWindow —— 用户看 A、模型读 B。
   * 现在面板一就绪就把 webContentsId 报上去（`browser:attach`），
   * 所有 browser_* 动作都打在同一页上；卸载时解绑。
   */
  useEffect(() => {
    const view = viewRef.current as unknown as
      | {
          addEventListener?: (t: string, cb: () => void) => void;
          removeEventListener?: (t: string, cb: () => void) => void;
          getWebContentsId?: () => number;
        }
      | null;
    if (!view?.addEventListener) return;
    const shell = (globalThis as unknown as {
      shell?: { browserAttach?: { attach: (id: number) => Promise<{ ok: boolean; error?: string }>; detach: (id?: number) => Promise<{ ok: boolean }> } };
    }).shell;
    let attachedId: number | null = null;
    const onReady = (): void => {
      try {
        const id = view.getWebContentsId?.();
        if (!id) return;
        attachedId = id;
        void shell?.browserAttach?.attach(id);
      } catch {
        /* 面板还没挂上 webContents（极早期）：下一次 dom-ready 再说 */
      }
    };
    view.addEventListener("dom-ready", onReady);
    /* 已经就绪的（重挂载时 dom-ready 不会再发）也补一次 */
    onReady();
    return () => {
      view.removeEventListener?.("dom-ready", onReady);
      if (attachedId !== null) void shell?.browserAttach?.detach(attachedId);
    };
  }, []);

  useEffect(() => {
    /* webview 的加载失败只给一句人话，不把 Chromium 的 -3 错误码糊到界面上 */
    const view = viewRef.current as unknown as
      | { addEventListener?: (t: string, cb: () => void) => void; removeEventListener?: (t: string, cb: () => void) => void }
      | null;
    if (!view?.addEventListener) return;
    const onFail = (): void => setNote("这个地址打不开（网络、证书或被站点拒绝）—— 可以换一个地址或用系统浏览器");
    const onOk = (): void => setNote("");
    view.addEventListener("did-fail-load", onFail);
    view.addEventListener("did-finish-load", onOk);
    return () => {
      view.removeEventListener?.("did-fail-load", onFail);
      view.removeEventListener?.("did-finish-load", onOk);
    };
  }, []);

  return (
    <div className="wb-browser" data-testid="wb-browser">
      <div className="wb-browser-bar">
        <button className="wb-icon" aria-label="后退" title="后退" onClick={() => call("goBack")}>
          <ArrowLeft size={13} />
        </button>
        <button className="wb-icon" aria-label="前进" title="前进" onClick={() => call("goForward")}>
          <ArrowRight size={13} />
        </button>
        <button className="wb-icon" aria-label="刷新" title="刷新" onClick={() => call("reload")}>
          <RefreshCw size={13} />
        </button>
        <input
          className="wb-browser-url"
          data-testid="wb-browser-url"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go(draft);
          }}
          placeholder="输入网址（http/https）"
        />
        <button className="wb-page-btn" data-testid="wb-browser-go" onClick={() => go(draft)}>
          <Globe size={12} /> 打开
        </button>
        <a
          className="wb-icon"
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label="用系统浏览器打开"
          title="用系统浏览器打开"
          data-testid="wb-browser-external"
        >
          <ExternalLink size={13} />
        </a>
      </div>
      {note ? (
        <div className="wb-browser-note" data-testid="wb-browser-note">
          {note}
        </div>
      ) : null}
      {/*
        名字带连字符是 React 对自定义元素的要求（`<webview>` 由 Electron 提供）。
        类型在 `src/webview.d.ts` 里声明 —— 不然 TS 会当成未知标签。
      */}
      <webview ref={viewRef as never} className="wb-browser-view" src={url} data-testid="wb-browser-view" />
    </div>
  );
}
