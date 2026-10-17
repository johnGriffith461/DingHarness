import { ReactFlowProvider } from "@xyflow/react";

import CanvasRuntime from "./CanvasRuntime";

/**
 * 画布的**懒加载入口**（D06，2026-10-18）。
 *
 * `Workbench` 只在 `canvasOpen` 时 `import()` 这个文件；它一被求值，
 * 同一个 chunk 里的 `@xyflow/react` 与 `CanvasRuntime` 才会下载/执行。
 *
 * 为什么把 provider 单独放一层：`ReactFlow` 要求 store 在 provider 内，
 * 而 provider 自己就是 `@xyflow/react` 的一部分 —— 所以它必须和画布一起懒加载，
 * 不能留在 `main.tsx`（那会让首屏也付这份钱）。
 */
export default function CanvasRuntimeHost() {
  return (
    <ReactFlowProvider>
      <CanvasRuntime />
    </ReactFlowProvider>
  );
}
