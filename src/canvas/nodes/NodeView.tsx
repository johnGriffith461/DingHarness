import type { ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";
import { bump } from "../renderProbe";

/**
 * 节点视图基类（对标原版 `data-node-view-wrapper`）。
 *
 * 每个节点类型 = 元信息（图标/标题/尺寸策略）+ 主体内容，
 * 外壳（选中描边、标题栏、连接点）统一在这里，不在各渲染器里重复。
 *
 * 尺寸策略两种：
 *   · `auto`（默认）—— 由内容撑开，适合文本、代码这类"有多少写多少"的节点
 *   · `fixed` —— 用 React Flow 给的 style 固定宽高，内容自己滚动/自适应，
 *     适合图表、白板这类"画布要占满整个卡片"的节点
 *
 * 连接点是必需的：没有 Handle，边找不到挂载点，React Flow 会持续告警
 * （`Couldn't create edge for source handle id: "null"`），后续连线功能也没法用。
 */

export type NodeViewProps = {
  /** 标题栏图标。 */
  icon?: ReactNode;
  /** 标题栏文字。 */
  title: string;
  /** 标题栏右侧的类型标签（如语言、尺寸）。 */
  tag?: string;
  /** 标题栏右侧的额外按钮。 */
  headActions?: ReactNode;
  /** 是否处于选中态（由 React Flow 通过 NodeProps 传入）。 */
  selected?: boolean;
  /** 是否整体锁定尺寸：true = 按节点的 style 固定宽高，内容自适应。 */
  fixedSize?: boolean;
  /** 额外的类名（如 `nv-code`）。 */
  className?: string;
  /** 节点内的交互控件（输入框等）需要 `nodrag`，挡住拖拽与框选。 */
  children: ReactNode;
};

export function NodeView({
  icon,
  title,
  tag,
  headActions,
  selected = false,
  fixedSize = false,
  className = "",
  children,
}: NodeViewProps) {
  bump("NodeView");
  const classes = ["nv", fixedSize ? "nv-fixed" : "nv-auto", selected ? "is-selected" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} data-node-view-wrapper data-node-state={selected ? "selected" : "idle"}>
      <Handle type="target" position={Position.Left} className="nv-port" />
      <div className="nv-head">
        {icon ? <span className="nv-icon">{icon}</span> : null}
        <span className="nv-title">{title}</span>
        {tag ? <span className="nv-tag">{tag}</span> : null}
        {headActions ? <span className="nv-head-actions nodrag">{headActions}</span> : null}
      </div>
      <div className={`nv-body${fixedSize ? " nv-grow" : ""}`}>{children}</div>
      <Handle type="source" position={Position.Right} className="nv-port" />
    </div>
  );
}
