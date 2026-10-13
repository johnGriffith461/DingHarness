import { memo, type ComponentType } from "react";

/**
 * 节点渲染器的 `memo` 比较器（2026-10-14）。
 *
 * ## 为什么要有这个
 * 先在打包产物里量过（`scripts/accept/measure-canvas-renders.mjs`，探针
 * `renderProbe.ts`）：拖动**一个**节点，15 步 mousemove 引起
 *
 *     合计 192 次渲染 = CanvasRuntime 16 + NodeView 112 + MarkdownNode 32
 *                       + CodeNode 16 + ImageNode 16
 *
 * 而画布上只有 6 个节点 —— 也就是说**每一步都把全部节点重渲染了一遍**。
 * 拖 A 不该让 B、C、D 跟着重画。
 *
 * ## 为什么这么比
 * React Flow 的 `applyNodeChanges` 对没被改动的节点是**原样透传**的
 * （同一个 `data` 引用），所以只比"画的是什么"这几项就够：
 *   · `id` / `data` —— 内容变没变
 *   · `selected` —— 选中描边
 *   · `dragging` —— 拖动中的样式
 *   · `type` —— 形状节点（`rect` / `ellipse` 共用一个渲染器）靠它决定画哪种
 *
 * **故意不比** `positionAbsoluteX/Y`、`width/height`、`zIndex` 这些：
 * 它们每帧都变，比了就等于没 memo；而它们的作用（定位、层级）由 React Flow
 * 在**外层包裹元素**上用 transform/style 直接管，不需要节点内容重渲染。
 *
 * ⚠️ 反过来说：**新写的节点渲染器如果直接用到了位置/尺寸，就不能套这个 memo** ——
 * 那种情况下它本来也不该属于"内容层"。这条注释就是给下一个人看的。
 * （已逐个核对过十个渲染器：都只取 `id / data / selected`，形状节点多一个 `type`。）
 */
export function sameNodeProps(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return (
    a.id === b.id &&
    a.data === b.data &&
    a.selected === b.selected &&
    a.dragging === b.dragging &&
    a.type === b.type
  );
}

/**
 * 把一个节点渲染器包成"内容没变就不重画"。
 *
 * 类型上放宽成 `ComponentType<any>`：React Flow 的 `NodeProps<T>` 联合
 * 与 `memo` 的比较器签名在这版 @xyflow/react 里对不齐，硬套会到处是断言，
 * 而这里的比较器本来就是**结构**比较（只认上面那四个字段）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function memoNode(Component: ComponentType<any>): ComponentType<any> {
  return memo(Component, sameNodeProps as never);
}
