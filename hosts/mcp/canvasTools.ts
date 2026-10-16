import path from "node:path";

import { CANVAS_NODE_KINDS } from "../../shared/agentTools";
import { CANVAS_TOOL_OPS, CANVAS_SURFACE, canvasSurfaceVerdict } from "../../engine/core/canvasContract";

/**
 * **画布 MCP server**（V5-4 任务 4.5：C6 工具族的 MCP 化形态）。
 *
 * ## 它是什么
 *
 * 把画布工具族按 **MCP**（Model Context Protocol）的形状暴露出去 —— 于是任何
 * 外部 MCP 客户端（别人的 agent、编辑器、脚本）都能**驱动这张画布**，
 * 而不必懂这个产品的内部结构。
 *
 * ```
 * 外部 MCP 客户端 ──stdio(JSON-RPC 2.0)──▶ 本 server ──▶ <data>/canvas/document.json
 * ```
 *
 * ## 一个刻意的选择：**文件**是唯一的"画布"
 *
 * 桌面端跑的时候，画布文档的真身在渲染进程里（用户正在看的那份）。而 MCP server
 * 是**另一个进程**，它只能碰磁盘 —— 所以这一版驱动的是
 * `<数据目录>/canvas/document.json`（与桌面/CLI 同一份 `CanvasDocument` 格式、
 * 同一个位置）。于是"外部客户端改了画布"这件事是**可验证**的：读那个文件就行。
 *
 * ⚠️ **如实说边界**：这一版**不是**热协作 —— 桌面正在打开同一张画布时，
 * 两边各写各的（后写的赢，`revision` 会跳）。接上真正的协作（把桌面那份也过事件流）
 * 是 V5-3 的方向，不是这个示范要假装已经做完的事。
 *
 * ## 工具面就是 C6 那张表
 *
 * 暴露哪些工具、每个工具属于哪个 surface（`read` / `query` / `create` / `link` /
 * `generate`），一律从 `engine/core/canvasContract.ts` 读 —— **不在这里重抄一遍**。
 * 抄一份的后果是"策略表里是 ask，MCP 这边放行"，而那种分叉在出问题之前没人看得见。
 */

/** 数据目录：与桌面/CLI 同一套口径（`DH_DATA_DIR` > `DSH_CANVAS_DATA_DIR` > `~/.ding`）。 */
export function canvasDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DH_DATA_DIR?.trim() || env.DSH_CANVAS_DATA_DIR?.trim();
  if (override) return override;
  return path.join(env.USERPROFILE ?? env.HOME ?? ".", ".ding");
}

/** 画布文档文件（与桌面 `snapshotStore.ts` 同一个相对位置）。 */
export function canvasDocPath(dataDir: string): string {
  return path.join(dataDir, "canvas", "document.json");
}

/** 一个工具在 MCP 里的声明（`tools/list` 的条目）。 */
export type McpTool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
};

/**
 * 这一版暴露的工具（`canvas_add_node` 是 C6 里**已经实现**的那一个）。
 *
 * ⚠️ 加新画布工具时：先在 `CANVAS_TOOL_OPS` 登记（那张表是判定的唯一来源），
 * 再来这里给 MCP 的声明 —— 两处都写，但**判定**只有一处。
 */
export function canvasTools(): McpTool[] {
  const addNode = "canvas_add_node";
  if (!(addNode in CANVAS_TOOL_OPS)) {
    /* 工具面是"从表里读"的：表里没有就什么都不暴露（而不是在这里另写一份定义） */
    return [];
  }
  return [
    {
      name: addNode,
      description:
        "往画布上加一个节点（markdown 文本或 code 代码）。" +
        `这个操作在工具轴上的判定是 \`${CANVAS_SURFACE.create}\`（会改内容 —— 宿主有闸门时应当先问）。`,
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...CANVAS_NODE_KINDS], description: "节点类型" },
          text: { type: "string", description: "节点内容（Markdown 原文或代码）" },
          lang: { type: "string", description: "kind=code 时的语言（默认 auto）" },
        },
        required: ["kind", "text"],
        additionalProperties: false,
      },
    },
  ];
}

/** 一次工具调用的结果（MCP 的 `CallToolResult`）。 */
export type McpToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** 一个画布节点（与渲染进程的 `makeMarkdownNode` / `makeCodeNode` 同形）。 */
export type CanvasNode = {
  id: string;
  type: "markdown" | "code";
  position: { x: number; y: number };
  data: Record<string, unknown>;
};

/** 画布文档（`CanvasDocument` 的字段子集：这版只碰这些）。 */
export type CanvasDoc = {
  version: number;
  revision: number;
  confirmedRevision: number;
  updatedAt?: string;
  viewport: { x: number; y: number; zoom: number };
  nodes: CanvasNode[];
  edges: unknown[];
  markers?: unknown[];
};

/** 默认文档（文件不存在时用——与桌面的默认视图口一致）。 */
export function emptyCanvasDoc(): CanvasDoc {
  return {
    version: 2,
    revision: 0,
    confirmedRevision: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    markers: [],
  };
}

/** 新节点的摆放位置：按已有节点数排成一列（不重叠 —— 打开就能看见）。 */
export function nextPosition(nodes: readonly CanvasNode[]): { x: number; y: number } {
  const column = nodes.length % 4;
  const row = Math.floor(nodes.length / 4);
  return { x: 80 + column * 340, y: 80 + row * 240 };
}

/**
 * **执行一次画布工具调用**（纯函数：给文档 + 输入，回新文档与结果）。
 *
 * 纯函数是刻意的：MCP 那一层只负责协议，改画布的规则在这里 —— 于是"加节点"
 * 这件事能在测试里直接算，不用起进程。
 */
export function applyCanvasTool(input: {
  doc: CanvasDoc;
  name: string;
  args: Record<string, unknown>;
  now?: number;
  nextId?: () => string;
}): { doc: CanvasDoc; result: McpToolResult } | { error: string } {
  if (!canvasSurfaceVerdict(input.name)) {
    return { error: `不认识的画布工具：${input.name}（这一版暴露的是：${canvasTools().map((t) => t.name).join(" / ")}）` };
  }

  const kind = String(input.args.kind ?? "");
  const text = String(input.args.text ?? "");
  if (!CANVAS_NODE_KINDS.includes(kind as (typeof CANVAS_NODE_KINDS)[number])) {
    return { error: `kind 只支持 ${CANVAS_NODE_KINDS.join(" / ")}（收到 ${JSON.stringify(input.args.kind)}）` };
  }
  if (!text.trim()) return { error: "text 不能是空的" };
  if (text.length > 2000) return { error: `text 太长（${text.length} 字，上限 2000）—— 与内置工具同一个数` };

  const id = input.nextId?.() ?? `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const node: CanvasNode =
    kind === "code"
      ? {
          id,
          type: "code",
          position: nextPosition(input.doc.nodes),
          data: { code: text, lang: String(input.args.lang ?? "auto"), title: "代码", preview: true },
        }
      : {
          id,
          type: "markdown",
          position: nextPosition(input.doc.nodes),
          data: { text, title: "文本", preview: true },
        };

  const doc: CanvasDoc = {
    ...input.doc,
    revision: input.doc.revision + 1,
    confirmedRevision: Math.max(input.doc.confirmedRevision, input.doc.revision + 1),
    updatedAt: new Date(input.now ?? Date.now()).toISOString(),
    nodes: [...input.doc.nodes, node],
  };
  return {
    doc,
    result: {
      content: [
        {
          type: "text",
          text: `已加到画布：${node.type} 节点 ${id}（现在共 ${doc.nodes.length} 个节点，revision ${doc.revision}）`,
        },
      ],
    },
  };
}
