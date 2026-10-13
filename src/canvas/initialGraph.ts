import type { Edge } from "@xyflow/react";
import type { CanvasNode } from "./types";
import {
  makeCodeNode,
  makeImageNode,
  makeMarkdownNode,
  makeMermaidNode,
  makeMindmapNode,
  makeWhiteboardNode,
} from "./types";

/**
 * 初始示例画布。
 *
 * 放六个节点，正好每种渲染器各来一个：这样"六种节点都能用"这件事
 * 一打开就能肉眼验收，不用点着菜单一个个试。
 */
export function createSampleGraph(): { nodes: CanvasNode[]; edges: Edge[] } {
  const nodes: CanvasNode[] = [
    makeMarkdownNode(
      "n1",
      { x: 120, y: 160 },
      [
        "# 无限画布",
        "",
        "这是自研工作台的第一版：React Flow v12 内核 + 六种可编辑节点。",
        "",
        "- **框选**：空白处拖拽拉框",
        "- **点选**：点节点编辑内容，点空白取消",
        "- **涂抹选**：按住划过，路径经过的节点全中",
        "- **平移**：拖空白移动画布，滚轮缩放",
        "",
        "撤销 `Ctrl+Z`、重做 `Ctrl+Shift+Z`、全选 `Ctrl+A`。",
      ].join("\n"),
      { width: 320, height: 300 },
      "使用说明",
    ),
    makeCodeNode(
      "n2",
      { x: 520, y: 120 },
      [
        'import { ReactFlow } from "@xyflow/react";',
        "",
        "// 画布内核与豆包 2.32.1 的 ai-views 同为 React Flow v12",
        'export const kernel = "xyflow@12";',
        "",
        "export function mount(el: HTMLElement) {",
        "  return createRoot(el).render(<ReactFlow />);",
        "}",
      ].join("\n"),
      "ts",
      { width: 460, height: 300 },
      "画布内核",
    ),
    makeMermaidNode(
      "n3",
      { x: 1040, y: 120 },
      [
        "flowchart LR",
        "  A[新建节点] --> B{类型?}",
        "  B -->|文本| C[Markdown]",
        "  B -->|代码| D[高亮]",
        "  B -->|图| E[Mermaid]",
      ].join("\n"),
      { width: 420, height: 300 },
      "流程",
    ),
    makeMindmapNode(
      "n4",
      { x: 160, y: 540 },
      [
        "# 工作台",
        "## 画布",
        "- 无限缩放",
        "- 三种选择",
        "## 节点",
        "- 文本 / 代码",
        "- 图片 / 图表",
        "## AI",
        "- 侧栏对话",
        "- 生成落节点",
      ].join("\n"),
      { width: 420, height: 320 },
      "结构",
    ),
    makeImageNode("n5", { x: 640, y: 560 }, "", "点击上传图片，可裁剪", { width: 320, height: 240 }, "图片"),
    makeWhiteboardNode("n6", { x: 1040, y: 560 }, { width: 420, height: 300 }, "白板"),
  ];

  const edges: Edge[] = [
    { id: "e1", source: "n1", target: "n2", label: "引用" },
    { id: "e2", source: "n2", target: "n3", label: "生成" },
  ];

  return { nodes, edges };
}
