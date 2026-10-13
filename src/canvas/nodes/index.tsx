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
import { memoNode } from "./memoNode";

/**
 * 节点渲染器注册表（对标原版 `async-canvas-*` 那一层的按类型分发）。
 *
 * 必须定义在组件外：`nodeTypes` 每次渲染都换新对象会让 React Flow 重建全部节点。
 * 阶段 2 落地六种（文本 / 代码 / 图片 / 导图 / 图表 / 白板），
 * 阶段 8.3 加了两种形状（矩形 / 椭圆，共用 `ShapeNode` 渲染器）。
 * 新增类型时在这里注册一次，并在 `types.ts` 的 `CanvasNode` 联合里加一支。
 */
/*
 * 每个渲染器都套一层 `memoNode`（2026-10-14）——
 * 实测拖动一个节点会让**全部**节点内容重渲染（见 `memoNode.ts` 里的数字）。
 * 包在这里而不是包在 `NodeView` 上：`children` 是每次渲染新造的 React 元素，
 * 只 memo 外壳挡不住（外壳照样被调用，等于白包）。
 */
export const nodeTypes: NodeTypes = {
  markdown: memoNode(MarkdownNodeView) as unknown as NodeTypes[string],
  code: memoNode(CodeNodeView) as unknown as NodeTypes[string],
  image: memoNode(ImageNodeView) as unknown as NodeTypes[string],
  mindmap: memoNode(MindmapNodeView) as unknown as NodeTypes[string],
  mermaid: memoNode(MermaidNodeView) as unknown as NodeTypes[string],
  whiteboard: memoNode(WhiteboardNodeView) as unknown as NodeTypes[string],
  rect: memoNode(ShapeNodeView) as unknown as NodeTypes[string],
  ellipse: memoNode(ShapeNodeView) as unknown as NodeTypes[string],
  frame: memoNode(FrameNodeView) as unknown as NodeTypes[string],
  html: memoNode(HtmlNodeView) as unknown as NodeTypes[string],
};
