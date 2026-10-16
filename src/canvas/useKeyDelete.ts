import { useCallback } from "react";
import type { Edge, Node } from "@xyflow/react";
import { useRuntimeStore } from "./runtimeStore";
import { pickKeyDelete, pickKeyDeleteEdges } from "./keyDelete";

/**
 * 删除键的两段接线（2026-10-16 审计 P106）。
 *
 * ## 为什么单独一份
 *
 * 画布上删除有两条路，取舍必须一致：
 *   · Ctrl+X / 右键「删除」/ 图层面板 → `store.removeSelected()`（画框里的卡片**不跟着走**）
 *   · React Flow 自带的删除键（`deleteKeyCode`）→ `getElementsToRemove()` 会把
 *     `parentId` 命中被删节点的**子节点一并收进删除集**
 *
 * 于是"选中画框按 Delete"会连带删掉框里的卡片，与 store 里明示的取舍相反。
 * 修法要两段配合（顺序由 React Flow 保证：`onNodesDelete` 先回调，之后才推 remove 变更）：
 *
 * 1. `onBeforeDelete` —— 把连带进来的子节点从待删集里**摘出去**（判据在 `keyDelete.ts`，
 *    那一条能单测），并同样筛一遍连线；
 * 2. `onNodesDelete` —— 被摘下来的子节点会"活着但父没了"，
 *    立刻把它们的坐标换成绝对、清掉 `parentId`（否则悬空父会被 React Flow 警告并按乱坐标渲染）。
 *
 * 抽成 hook 而不是塞回 `CanvasRuntime`：那两段是**纯接线**（读 store、算、写 store），
 * 与画布的总装（工具条/React Flow 的 props）不是一回事；`structureGuard` 也在盯
 * `CanvasRuntime.tsx` 的行数 —— 把它留在这儿顺带让那个文件回到上限内。
 */
export function useKeyDelete(): {
  onBeforeDelete: (params: { nodes: Node[]; edges: Edge[] }) => Promise<{ nodes: Node[]; edges: Edge[] }>;
  onNodesDelete: (deleted: Node[]) => void;
} {
  const onBeforeDelete = useCallback(async ({ nodes: doomed, edges: doomedEdges }: { nodes: Node[]; edges: Edge[] }) => {
    const current = useRuntimeStore.getState().nodes;
    const selected = new Set(current.filter((n) => n.selected).map((n) => n.id));
    const nodes = pickKeyDelete(doomed, selected);
    const removed = new Set(nodes.map((n) => n.id));
    const survivors = new Set(current.filter((n) => !removed.has(n.id)).map((n) => n.id));
    return { nodes, edges: pickKeyDeleteEdges(doomedEdges, survivors) };
  }, []);

  const onNodesDelete = useCallback((deleted: Node[]) => {
    useRuntimeStore.getState().adoptOrphans(deleted.map((n) => n.id));
  }, []);

  return { onBeforeDelete, onNodesDelete };
}
