import React from "react";
import ReactDOM from "react-dom/client";
import { ReactFlowProvider } from "@xyflow/react";
import App from "./App";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { installInputModality } from "./workbench/inputModality";

/* 输入模态标记（鼠标点进去不描圈、Tab 进来才给焦点环）—— 见 `inputModality.ts` */
installInputModality();

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {/* React Flow 要求 store 在 provider 内 —— 对标原版的 CanvasReactRuntimeProvider */}
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  </React.StrictMode>,
);
