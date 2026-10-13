import Workbench from "@/workbench/Workbench";

/**
 * 应用入口。
 *
 * 形态对齐原版（HANDOFF §25）：**工作台外壳**才是根 —— 左导航 / 中任务 / 右摘要，
 * 画布是开在旁边的"产物面板"，不是主界面。
 *
 * 早先的实现把画布当主界面（`App` 里直接铺 `CanvasRuntime`），那是对原版的误解：
 * 原版里画布始终是任务产物的展示处，由对话驱动。现在改成工作台外壳，
 * 画布与它的对话侧栏一起收进 `wb-canvas` 面板里（功能一个没少）。
 */
export default function App() {
  return <Workbench />;
}
