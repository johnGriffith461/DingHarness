/**
 * 变更分类（2026-10-16 审计 P22）。
 *
 * 画布的撤销点与修订号都取决于"这次变更算不算结构性的" —— 这个判断原来散在
 * `CanvasRuntime.onNodesChange` 里，写错一次就是"打字把撤销栈灌满"那种**手感级**
 * 的坏（用户不会报「撤销栈有二十条」，只会说"Ctrl+Z 按不动"）。
 *
 * 抽出来是为了能被断言：判据本身是纯函数，一条用例就能钉住它。
 */

/** 变更对象里这里只用得到 `type`（React Flow 的 `NodeChange` / `EdgeChange` 都有它）。 */
export type TypedChange = { type: string };

/**
 * 节点变更里有没有**结构性**的那一种（该打一个撤销点）。
 *
 * ⚠️ `replace` **不算**：`updateNodeData` 每次击键都会发一条 `replace`
 * （`useNodeActions.setData` 那条路），把它算成结构性的话，
 * "在节点里打 20 个字"就是 20 个撤销点 —— `beginEdit` 的 800ms 合并窗口被整条绕过。
 * 连续输入的那一个撤销点由 `beginEdit` 负责，这里只认真正"图变了"的 `remove`。
 *
 * `select` / `dimensions` 本来就不算（选择态与测量是视图层面的东西，不该推动画布内容）。
 */
export function nodesAreStructural(changes: readonly TypedChange[]): boolean {
  return changes.some((c) => c.type === "remove");
}

/**
 * 连线变更里有没有结构性的那一种。
 *
 * 与节点不同：连线这里 `replace` 要算 —— 它来自**重连**（把一条线的端点拖到别的节点上），
 * 那是真的改了图，值得一个撤销点（而节点那边的 `replace` 是击键带来的噪音）。
 */
export function edgesAreStructural(changes: readonly TypedChange[]): boolean {
  return changes.some((c) => c.type === "remove" || c.type === "replace");
}
