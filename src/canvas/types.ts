import type { Node } from "@xyflow/react";
import type { TextStyle } from "./textStyle";

/**
 * 画布节点类型定义（对标原版 `async-canvas-*` 系列）。
 *
 * 阶段 2 落的六种：markdown 文本 / code 代码 / image 图片 / mindmap 思维导图 /
 * mermaid 图表 / whiteboard 白板。每种 = 一个数据形状 + 一个渲染器 + 一个创建入口。
 *
 * 数据里只放"用户内容"，不放渲染中间态（例如白板的笔迹按需同步、Mermaid 的渲染结果
 * 不入库），这样阶段 4 的快照体积可控、也不会有渲染产物污染内容模型。
 */

/** 卡片尺寸：初始尺寸只是占位，真实尺寸由 React Flow 测量（`measured`）覆盖。 */
export type CardSize = { width: number; height: number };

/**
 * 所有节点共有的图层字段（阶段 8.1 / 8.2）。
 *
 * 「图层」这件事对每种节点都成立（卡片/图片/形状都能锁、能翻、能显隐），
 * 所以放在这里让六种数据形状都继承，而不是给每个类型各加一遍、
 * 也不是在改动处到处 `as unknown as` 硬转（那样丢类型保护）。
 */
export type LayerFields = {
  /** 锁定后不可拖动，但仍可选中查看（对标 `layerContext` 里的锁定语义）。 */
  locked?: boolean;
  /** 水平翻转（图片/形状用）。 */
  flipX?: boolean;
  /** 垂直翻转。 */
  flipY?: boolean;
  /**
   * 文字排版（阶段 8.5，对标 `aiCreation_canvas_textAction_*`）。
   * 放在共有字段上：卡片、形状、画框都有文字，排版对它们一视同仁。
   */
  textStyle?: TextStyle;
};

/** Markdown / 纯文本节点。 */
export type MarkdownData = LayerFields & {
  /** 原文（编辑态所见）。 */
  text: string;
  title: string;
  /** 预览态：渲染 Markdown；编辑态：纯文本输入。 */
  preview?: boolean;
};

/** 代码节点。 */
export type CodeData = LayerFields & {
  code: string;
  lang: string;
  title: string;
  /** 预览态显示高亮结果，编辑态显示可输入的纯文本。 */
  preview?: boolean;
};

/** 图片裁剪参数（对标原版接 `react-easy-crop`）。 */
export type ImageCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 图片节点。 */
export type ImageData = LayerFields & {
  /** 展示用的源（dataURL、`dshasset://` 或落盘后的 file:// / 本地路径）。 */
  src: string;
  alt: string;
  title: string;
  /** 相对原图的裁剪框（像素，基于原图坐标）。 */
  crop?: ImageCrop;
  /** 原图尺寸，用于把裁剪框换算成百分比显示。 */
  natural?: { width: number; height: number };
  /** 原始文件在磁盘上的相对路径（阶段 2 起由主进程落盘，便于快照只存路径）。 */
  filePath?: string;
  /** 由哪个图像模型生成的（阶段 9.2；人工上传的图没有这个字段）。 */
  generatedBy?: string;
};

/** 思维导图节点：由 Markdown 大纲生成（markmap）。 */
export type MindmapData = LayerFields & {
  markdown: string;
  title: string;
  /** 展开层级：1 只显示一级，Infinity 全展开。 */
  depth?: number;
};

/** 图表节点：Mermaid 源码。 */
export type MermaidData = LayerFields & {
  code: string;
  title: string;
};

/** 白板的画笔种类。 */
export type WhiteboardTool = "pen" | "eraser";

/** 一笔（一条路径）：世界坐标 + 颜色 + 粗细。 */
export type WhiteboardStroke = {
  tool: WhiteboardTool;
  color: string;
  width: number;
  /** 扁平化坐标 [x0, y0, x1, y1, ...]，比对象数组省空间。 */
  points: number[];
};

/** 白板节点。 */
export type WhiteboardData = LayerFields & {
  title: string;
  strokes: WhiteboardStroke[];
  color: string;
  penWidth: number;
  tool: WhiteboardTool;
};

/**
 * 形状节点（阶段 8.3，对标原版 `data-shape-kind` 与
 * `aiCreation_canvas_shape_{circle,rectangle}`）。
 *
 * 原版把"矩形 / 椭圆"做成两个建出来的形状，这里同样是**两个节点类型**
 * （`rect` / `ellipse`）共用一个渲染器与一份数据形状：
 *   · 分两个类型 → 创建菜单里天然出现两项，不用额外做"预设"机制
 *   · 共用数据形状 → 只维护一套属性（填充/描边/圆角/文字）
 */
export type ShapeKind = "rect" | "ellipse";

export type ShapeData = LayerFields & {
  title: string;
  /** 形状种类（与节点类型保持一致，渲染器读它决定画什么）。 */
  shape: ShapeKind;
  /** 填充色；空串表示不填充（只有描边）。 */
  fill: string;
  stroke: string;
  /** 描边宽度（画布单位）。 */
  strokeWidth: number;
  /** 圆角半径（仅矩形有意义，对标 `textAction_borderWidth` 那一族里圆角的做法）。 */
  radius: number;
  /** 形状里居中显示的文字（可为空）。 */
  text: string;
};

/**
 * 画框节点（阶段 8.4，对标原版 `data-canvas-frame-id` /
 * `data-canvas-frame-creation-surface` / `moveFrameWithChildren`）。
 *
 * 画框是"一块画布里的一个页面/区域"：它自己是个容器，**拖动它要把它框住的节点一起带走**
 * （原版就是 `moveFrameWithChildren` 这个语义）。这也是设计画布与卡片墙的分水岭 ——
 * 有了画框，用户才能说"这一屏是我的首页"，然后整体挪动、整体导出。
 *
 * 实现走 React Flow 原生的父子关系（`parentId`）：把被框住的节点设成画框的子节点，
 * 父节点移动时 React Flow 会自动带上子节点，不需要自己算相对位移。
 */
export type FrameData = LayerFields & {
  title: string;
  /** 画框底色（很淡的一层，表示这是块区域而不是一个卡片）。 */
  fill: string;
  /** 框线颜色。 */
  stroke: string;
  /** 是否把画框画成"只有框、没有底"的样式。 */
  outlineOnly?: boolean;
};

/**
 * HTML 节点（阶段 9.1，对标原版 `data-canvas-html-*`）。
 *
 * 渲染在**沙箱 iframe** 里，且**只给 `allow-scripts`、不给 `allow-same-origin`** ——
 * 原版两个一起给，等于沙箱自毁（被框内容能自己摘掉 sandbox 摸到宿主）。
 * 详见 `htmlFrame.ts` 的说明。
 */
export type HtmlData = LayerFields & {
  title: string;
  /** 用户写的 HTML（可以是碎片，也可以是整页）。 */
  html: string;
  /** 预览态：渲染；编辑态：纯文本编辑源码。 */
  preview?: boolean;
  /**
   * 是否放行 https 外链（脚本/样式/请求）。
   * 默认 **false = 断网**：粘贴进来的 HTML 不该能悄悄往外发数据。
   */
  allowNetwork?: boolean;
};

/** 全部节点数据的联合类型（新增节点类型时在这里加一支）。 */
export type CanvasNodeData =
  | MarkdownData
  | CodeData
  | ImageData
  | MindmapData
  | MermaidData
  | WhiteboardData
  | ShapeData
  | FrameData
  | HtmlData;

export type MarkdownNode = Node<MarkdownData, "markdown">;
export type CodeNode = Node<CodeData, "code">;
export type ImageNode = Node<ImageData, "image">;
export type MindmapNode = Node<MindmapData, "mindmap">;
export type MermaidNode = Node<MermaidData, "mermaid">;
export type WhiteboardNode = Node<WhiteboardData, "whiteboard">;
/** 矩形 / 椭圆：共用一份数据形状，只是节点类型不同。 */
export type RectNode = Node<ShapeData, "rect">;
export type EllipseNode = Node<ShapeData, "ellipse">;
/** 画框：一个容器节点，被它框住的节点会挂在它下面。 */
export type FrameNode = Node<FrameData, "frame">;
/** HTML：沙箱里渲染的一段 HTML。 */
export type HtmlNode = Node<HtmlData, "html">;

/** 画布上允许出现的节点联合类型；新增节点类型时在这里加一支以及 `nodeTypes` 注册。 */
export type CanvasNode =
  | MarkdownNode
  | CodeNode
  | ImageNode
  | MindmapNode
  | MermaidNode
  | WhiteboardNode
  | RectNode
  | EllipseNode
  | FrameNode
  | HtmlNode;

/* ============================================================
 * 节点工厂
 * ============================================================ */

export function makeMarkdownNode(
  id: string,
  position: { x: number; y: number },
  text: string,
  size?: CardSize,
  title = "文本",
): MarkdownNode {
  return { id, type: "markdown", position, data: { text, title, preview: true }, ...(size ?? {}) };
}

export function makeCodeNode(
  id: string,
  position: { x: number; y: number },
  code: string,
  lang = "ts",
  size?: CardSize,
  title = "代码",
): CodeNode {
  return { id, type: "code", position, data: { code, lang, title, preview: true }, ...(size ?? {}) };
}

export function makeImageNode(
  id: string,
  position: { x: number; y: number },
  src = "",
  alt = "",
  size?: CardSize,
  title = "图片",
): ImageNode {
  return { id, type: "image", position, data: { src, alt, title }, ...(size ?? {}) };
}

export function makeMindmapNode(
  id: string,
  position: { x: number; y: number },
  markdown: string,
  size?: CardSize,
  title = "思维导图",
): MindmapNode {
  return { id, type: "mindmap", position, data: { markdown, title }, ...(size ?? {}) };
}

export function makeMermaidNode(
  id: string,
  position: { x: number; y: number },
  code: string,
  size?: CardSize,
  title = "图表",
): MermaidNode {
  return { id, type: "mermaid", position, data: { code, title }, ...(size ?? {}) };
}

export function makeWhiteboardNode(
  id: string,
  position: { x: number; y: number },
  size?: CardSize,
  title = "白板",
): WhiteboardNode {
  return {
    id,
    type: "whiteboard",
    position,
    data: { title, strokes: [], color: "#60a5fa", penWidth: 3, tool: "pen" },
    ...(size ?? {}),
  };
}

/** 形状节点的默认配色（对标原版形状的"能一眼看出来是个设计元素"的观感）。 */
export const SHAPE_DEFAULTS = {
  fill: "rgba(96, 165, 250, 0.18)",
  stroke: "#60a5fa",
  strokeWidth: 2,
  radius: 10,
} as const;

/**
 * 造一个形状节点。
 *
 * @param id 节点 id
 * @param position 位置
 * @param shape 矩形还是椭圆
 * @param size 初始尺寸
 * @param text 形状里显示的文字（可空）
 * @returns 形状节点
 */
export function makeShapeNode(
  id: string,
  position: { x: number; y: number },
  shape: ShapeKind,
  size?: CardSize,
  text = "",
): RectNode | EllipseNode {
  const title = shape === "rect" ? "矩形" : "椭圆";
  const data: ShapeData = {
    title,
    shape,
    fill: SHAPE_DEFAULTS.fill,
    stroke: SHAPE_DEFAULTS.stroke,
    strokeWidth: SHAPE_DEFAULTS.strokeWidth,
    radius: SHAPE_DEFAULTS.radius,
    text,
  };
  if (shape === "rect") {
    return { id, type: "rect", position, data, ...(size ?? {}) };
  }
  return { id, type: "ellipse", position, data, ...(size ?? {}) };
}

/** 画框的默认样式（很淡的一层底，表示"这是块区域"）。 */
export const FRAME_DEFAULTS = {
  fill: "rgba(148, 163, 184, 0.06)",
  stroke: "rgba(148, 163, 184, 0.45)",
} as const;

/**
 * 造一个画框节点。
 *
 * 注意 `zIndex: -1`：画框必须**永远在它框住的内容下面**，
 * 否则它会盖住里面的卡片，用户点不到里面的东西。
 */
export function makeFrameNode(
  id: string,
  position: { x: number; y: number },
  size?: CardSize,
  title = "画框",
): FrameNode {
  return {
    id,
    type: "frame",
    position,
    zIndex: -1,
    data: { title, fill: FRAME_DEFAULTS.fill, stroke: FRAME_DEFAULTS.stroke },
    ...(size ?? {}),
  };
}

/** HTML 节点的初始内容：一个小示例，打开就能看懂这个节点干什么。 */
export const HTML_SAMPLE = `<div style="padding:8px 4px">
  <h2 style="margin:0 0 8px">这是一段 HTML</h2>
  <p style="margin:0 0 10px;color:#555">双击卡头或点「编辑」改源码，点「预览」看渲染结果。</p>
  <button style="padding:6px 14px;border:0;border-radius:6px;background:#3b82f6;color:#fff;cursor:pointer"
          onclick="this.textContent='点到了 '+new Date().toLocaleTimeString()">
    点我一下
  </button>
</div>`;

/**
 * 造一个 HTML 节点。
 * @param id 节点 id
 * @param position 位置
 * @param size 初始尺寸
 * @param html 初始 HTML（默认给一段能看懂的示例）
 */
export function makeHtmlNode(
  id: string,
  position: { x: number; y: number },
  size?: CardSize,
  html: string = HTML_SAMPLE,
): HtmlNode {
  return {
    id,
    type: "html",
    position,
    data: {
      title: "HTML",
      html,
      // 默认进预览态：建出来就能看到东西，而不是一坨源码
      preview: true,
      // 默认断网（详见 htmlFrame.ts）
      allowNetwork: false,
    },
    ...(size ?? {}),
  };
}

/** 可直接放进工具栏「新建」菜单的节点类型清单。 */
export type NodeKind = CanvasNode["type"];

/** 每个类型的默认初始尺寸与默认内容。 */
export const NODE_KIND_META: Record<
  NodeKind,
  { label: string; size: CardSize; hint: string; create: (id: string, at: { x: number; y: number }) => CanvasNode }
> = {
  markdown: {
    label: "文本",
    hint: "Markdown 文本，自动中英混排",
    size: { width: 320, height: 200 },
    create: (id, at) => makeMarkdownNode(id, at, "# 标题\n\n写点什么，支持 **Markdown** 语法。"),
  },
  code: {
    label: "代码",
    hint: "语法高亮，可换语言",
    size: { width: 440, height: 240 },
    create: (id, at) =>
      makeCodeNode(id, at, 'const hello = "world";\nconsole.log(`你好, ${hello}`);\n', "ts"),
  },
  image: {
    label: "图片",
    hint: "上传本地图片，可裁剪",
    size: { width: 320, height: 240 },
    create: (id, at) => makeImageNode(id, at, "", "点击上传图片"),
  },
  mindmap: {
    label: "思维导图",
    hint: "从 Markdown 大纲生成",
    size: { width: 420, height: 300 },
    create: (id, at) =>
      makeMindmapNode(id, at, "# 中心主题\n## 分支一\n- 要点 A\n- 要点 B\n## 分支二\n- 要点 C\n"),
  },
  mermaid: {
    label: "图表",
    hint: "Mermaid 流程图 / 时序图",
    size: { width: 440, height: 300 },
    create: (id, at) =>
      makeMermaidNode(id, at, "flowchart LR\n  A[开始] --> B{判断}\n  B -->|是| C[执行]\n  B -->|否| D[结束]\n"),
  },
  whiteboard: {
    label: "白板",
    hint: "手绘，可擦除",
    size: { width: 400, height: 300 },
    create: (id, at) => makeWhiteboardNode(id, at),
  },
  rect: {
    label: "矩形",
    hint: "矩形色块 / 框，可写文字",
    size: { width: 240, height: 160 },
    create: (id, at) => makeShapeNode(id, at, "rect"),
  },
  ellipse: {
    label: "椭圆",
    hint: "椭圆 / 圆形，可写文字",
    size: { width: 220, height: 160 },
    create: (id, at) => makeShapeNode(id, at, "ellipse"),
  },
  frame: {
    label: "画框",
    hint: "一块区域/页面：拖它会带走框住的节点",
    size: { width: 520, height: 380 },
    create: (id, at) => makeFrameNode(id, at),
  },
  html: {
    label: "HTML",
    hint: "在沙箱里渲染一段 HTML（默认断网）",
    size: { width: 420, height: 300 },
    create: (id, at) => makeHtmlNode(id, at),
  },
};

/**
 * 节点 id 生成。
 *
 * 初始示例画布用了 `n1 / n2 / n3` 这类固定 id，所以新建节点必须先问一次
 * "这个 id 有没有人用"，否则会和示例节点撞号 —— 撞号的后果是 store 里出现
 * 两个同 id 节点，DOM 只渲染一个，React 报 "two children with the same key"，
 * 而且删除/拖拽会作用到错误的那个节点。
 */

/** 节点 id 的形态：前缀 + 数字。 */
export const NODE_ID_PATTERN = /^([A-Za-z]+)(\d+)$/;

/** 与 `initialGraph.ts` 里示例节点使用的前缀保持一致。 */
export const NODE_ID_PREFIX = "n";

/**
 * 生成一个当前没被占用的节点 id。
 * @param nodes 现存节点（读它们的 id 做占用判断）
 */
export function nextNodeId(nodes: Array<{ id: string }>): string {
  let max = 0;
  for (const node of nodes) {
    const match = NODE_ID_PATTERN.exec(node.id);
    if (match && match[1] === NODE_ID_PREFIX) {
      const value = Number(match[2]);
      if (Number.isFinite(value) && value > max) max = value;
    }
  }
  return `${NODE_ID_PREFIX}${max + 1}`;
}
