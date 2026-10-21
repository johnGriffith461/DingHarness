/**
 * `<webview>` 由 Electron 提供，TS 不认识它。只声明我们真的用到的属性。
 * ⚠️ 它只在主进程开了 `webPreferences.webviewTag` 时存在（见 `electron/main.ts`）。
 */
declare namespace JSX {
  interface IntrinsicElements {
    webview: {
      src?: string;
      className?: string;
      ref?: unknown;
      partition?: string;
      allowpopups?: string;
      "data-testid"?: string;
    };
  }
}
