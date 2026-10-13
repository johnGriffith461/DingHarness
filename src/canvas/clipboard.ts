import type { Edge } from "@xyflow/react";
import type { CanvasNode } from "./types";
import { nextNodeId } from "./types";

/**
 * 画布剪贴板（PLAN 4.6，对标原版 `clipboard-*` 与
 * "Clipboard graph is not JSON serializable" 这条显式报错）。
 *
 * 设计要点：
 *   · 走**文本**剪贴板（一段带标记的 JSON），不是内部登台变量 ——
 *     这样能跨窗口粘、也能被用户看见/排查，符合原版"画布图可序列化"的语义。
 *   · 序列化失败**必须显式报错**，不能静默失败：原版专门有一条
 *     "Clipboard graph is not JSON serializable" 的提示，说明这是被当回事的边界。
 *   · 粘贴时**重排 id**（原 id 在目标画布上可能已被占用），并只保留"两端都在复制集内"
 *     的连线 —— 否则粘贴出来的边会指到别人的节点上。
 */

/** 剪贴板载荷的格式标记：粘别人的文本进来时能认出来。 */
export const CLIPBOARD_MARK = "dsh-canvas-graph/v1";

export type ClipboardPayload = {
  mark: string;
  nodes: CanvasNode[];
  edges: Edge[];
};

/**
 * 把节点（及它们之间的连线）序列化成可放进剪贴板的一段文本。
 *
 * @param nodes 要复制的节点
 * @param edges 当前画布上的全部连线（只挑两端都在复制集内的）
 * @returns 序列化后的文本
 * @throws 当内容无法 JSON 序列化时（例如用户往 data 里塞了函数/DOM 引用）
 */
export function serializeClipboard(nodes: CanvasNode[], edges: Edge[]): string {
  const ids = new Set(nodes.map((n) => n.id));
  const inner = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const payload: ClipboardPayload = { mark: CLIPBOARD_MARK, nodes, edges: inner };
  try {
    const text = JSON.stringify(payload);
    if (typeof text !== "string") throw new Error("序列化没有产出文本");
    return text;
  } catch (error) {
    // 这条错误会被界面原样显示给用户（对标原版那条提示）
    throw new Error(
      `画布内容无法序列化，已取消复制：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * 解析剪贴板文本。
 * @param text 剪贴板内容
 * @returns 解析结果；不是本程序的载荷时返回 null（不报错，直接忽略）
 */
export function parseClipboard(text: string): ClipboardPayload | null {
  if (!text || !text.includes(CLIPBOARD_MARK)) return null;
  try {
    const parsed = JSON.parse(text) as ClipboardPayload;
    if (parsed?.mark !== CLIPBOARD_MARK) return null;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export type PastePlan = {
  nodes: CanvasNode[];
  edges: Edge[];
  /** 新节点 id，供调用方选中它们。 */
  created: string[];
};

/**
 * 规划一次粘贴：重排 id、整体位移、只保留内部连线。
 *
 * @param payload 剪贴板内容
 * @param existing 当前画布上的节点（用来分配不冲突的新 id）
 * @param at 粘贴锚点（新内容的外接框左上角会落在这里）
 * @returns 要追加的节点、连线与新 id 列表
 */
export function planPaste(
  payload: ClipboardPayload,
  existing: CanvasNode[],
  at: { x: number; y: number },
): PastePlan {
  const sources = payload.nodes;
  if (sources.length === 0) return { nodes: [], edges: [], created: [] };

  // 逐个分配新 id（对着不断增长的列表算，避免复制体之间撞 id）
  const idMap = new Map<string, string>();
  let pool = existing;
  for (const source of sources) {
    const id = nextNodeId(pool);
    idMap.set(source.id, id);
    pool = [...pool, { ...source, id }];
  }

  // 整体位移：让复制体的外接框左上角落在锚点
  const minX = Math.min(...sources.map((n) => n.position.x));
  const minY = Math.min(...sources.map((n) => n.position.y));
  const dx = at.x - minX;
  const dy = at.y - minY;

  const nodes = sources.map(
    (source) =>
      ({
        ...source,
        id: idMap.get(source.id) as string,
        position: { x: source.position.x + dx, y: source.position.y + dy },
        selected: true,
      }) as CanvasNode,
  );

  const edges = payload.edges
    .filter((e) => idMap.has(e.source) && idMap.has(e.target))
    .map((e, index) => ({
      ...e,
      id: `${e.id}-paste-${index + 1}`,
      source: idMap.get(e.source) as string,
      target: idMap.get(e.target) as string,
      selected: false,
    }));

  return { nodes, edges, created: nodes.map((n) => n.id) };
}
