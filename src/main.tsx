import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { installInputModality } from "./workbench/inputModality";

/* 输入模态标记（鼠标点进去不描圈、Tab 进来才给焦点环）—— 见 `inputModality.ts` */
installInputModality();

/*
 * 启动打点（D06，2026-10-18）。
 *
 * 产品审计量到"桌面可操作 3540ms"，而那时没有任何分段数据 —— 只能看到一个总数。
 * 这里用 Performance API 留下三段：脚本开始 / React 挂载 / 首帧绘制。
 * 只打 mark（不往控制台刷日志），需要时在 devtools 的 Performance 面板里直接看得见；
 * `scripts/perf-budget.ts` 也可以读 Electron 的 CDP 取这些名字。
 *
 * ⚠️ 画布（`@xyflow/react`）已经从首屏拆成懒加载块（见 `Workbench.tsx`）：
 * 它只在用户真的打开画布时才下载/执行。首屏不该为一整块画布付启动成本。
 */
performance.mark("dsh:script-start");

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

/* 首帧：下一次绘制前打点（rAF 回调在那一帧的绘制之前执行）。 */
requestAnimationFrame(() => {
  performance.mark("dsh:first-frame");
  try {
    performance.measure("dsh:boot", "dsh:script-start", "dsh:first-frame");
  } catch {
    /* 某些环境下 mark 被清掉了 —— 打点失败不该影响启动 */
  }
});
