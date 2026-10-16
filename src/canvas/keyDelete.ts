/**
 * 「按 Delete/Backspace」到底该删哪些（2026-10-16 审计 P106）。
 *
 * ## 为什么需要它
 *
 * 画布上的删除有两条路，取舍必须一致：
 *   · Ctrl+X / 右键「删除」/ 图层面板的删除 → `store.removeSelected()`
 *     （它会把画框里**没被选中**的卡片救回顶层，不连带删）
 *   · React Flow 自带的删除键（`deleteKeyCode={["Backspace","Delete"]}`）
 *     → `@xyflow/system` 的 `getElementsToRemove()`，它会把 `parentId`
 *       命中被删节点的**子节点一并收进删除集**
 *
 * 于是"选中画框按 Delete"会**连带删掉框里的卡片** —— 与 store 里明示的取舍相反，
 * 也与右键删除的结果不一致（同一个动作两种后果）。
 *
 * ## 判据
 *
 * 连带进来的子节点与"用户真的选中的"可以分开：**父在被删之列、而自己没被选中**的那些
 * 就是连带项。它们从删除集里去掉，再由 `adoptOrphans` 把坐标换算成绝对、清掉 `parentId`。
 *
 * 抽成纯函数是为了能立用例：`@xyflow/system` 那一层的连带逻辑没法在 node 环境里
 * 单独跑，而"哪些该去掉"这个判断在这里，能直接断。
 */

/**
 * 从 React Flow 给出的"待删集"里挑出**真的该删**的节点。
 *
 * @param doomed React Flow 算出来的待删节点（含连带进来的子节点）
 * @param selectedIds 当前真的被选中的节点 id
 * @returns 该删的那些（顺序不变）；用户明确选中的子节点仍然照删
 */
export function pickKeyDelete<T extends { id: string; parentId?: string }>(
  doomed: readonly T[],
  selectedIds: ReadonlySet<string>,
): T[] {
  const doomedIds = new Set(doomed.map((n) => n.id));
  return doomed.filter((node) => {
    if (selectedIds.has(node.id)) return true; // 用户自己也选中了它 → 照删
    if (!node.parentId) return true; // 没有父 → 不是连带项
    /*
     * 父也在待删集里 = 它是被"父被删"连带进来的。
     * 父不在待删集里却出现在待删集？那只可能是它自己被选中了 —— 上一行已放行。
     */
    return !doomedIds.has(node.parentId);
  });
}

/**
 * 从待删集里挑出**要删的连线**。
 *
 * 与节点同理：连带的子节点被救下来之后，只跟它们相连的线不该跟着消失。
 *
 * @param doomedEdges React Flow 算出来的待删连线
 * @param survivors 删完之后还活着的节点 id
 * @returns 该删的连线
 */
export function pickKeyDeleteEdges<T extends { source: string; target: string; selected?: boolean }>(
  doomedEdges: readonly T[],
  survivors: ReadonlySet<string>,
): T[] {
  return doomedEdges.filter((edge) => {
    if (edge.selected) return true; // 用户显式选中的连线照样删
    return !survivors.has(edge.source) || !survivors.has(edge.target);
  });
}
