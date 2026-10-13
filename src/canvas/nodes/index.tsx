import type { NodeTypes } from "@xyflow/react";
import MarkdownNodeView from "./MarkdownNode";
import CodeNodeView from "./CodeNode";
import ImageNodeView from "./ImageNode";
import MindmapNodeView from "./MindmapNode";
import MermaidNodeView from "./MermaidNode";
import WhiteboardNodeView from "./WhiteboardNode";
import ShapeNodeView from "./ShapeNode";
import FrameNodeView from "./FrameNode";
import HtmlNodeView from "./HtmlNode";

/**
 * 节点渲染器注册表（对标原版 `async-canvas-*` 那一层的按类型分发）。
 *
 * 必须定义在组件外：`nodeTypes` 每次渲染都换新对象会让 React Flow 重建全部节点。
 * 阶段 2 落地六种（文本 / 代码 / 图片 / 导图 / 图表 / 白板），
 * 阶段 8.3 加了两种形状（矩形 / 椭圆，共用 `ShapeNode` 渲染器）。
 * 新增类型时在这里注册一次，并在 `types.ts` 的 `CanvasNode` 联合里加一支。
 */
export const nodeTypes: NodeTypes = {
  markdown: MarkdownNodeView as unknown as NodeTypes[string],
  code: CodeNodeView as unknown as NodeTypes[string],
  image: ImageNodeView as unknown as NodeTypes[string],
  mindmap: MindmapNodeView as unknown as NodeTypes[string],
  mermaid: MermaidNodeView as unknown as NodeTypes[string],
  whiteboard: WhiteboardNodeView as unknown as NodeTypes[string],
  rect: ShapeNodeView as unknown as NodeTypes[string],
  ellipse: ShapeNodeView as unknown as NodeTypes[string],
  frame: FrameNodeView as unknown as NodeTypes[string],
  html: HtmlNodeView as unknown as NodeTypes[string],
};
