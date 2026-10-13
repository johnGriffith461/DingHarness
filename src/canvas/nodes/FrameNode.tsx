import { useEffect, useRef, useState } from "react";
import { Frame } from "lucide-react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import type { FrameNode as FrameNodeType } from "../types";
import { useRuntimeStore } from "../runtimeStore";

/**
 * 画框节点（阶段 8.4，对标原版 `data-canvas-frame-id` /
 * `data-canvas-frame-creation-surface` / `moveFrameWithChildren`）。
 *
 * 它是"一块画布里的一个页面/区域"：
 *   · 拖动画框 → 它框住的节点**一起走**（靠 React Flow 的父子关系实现，不用自己算位移）
 *   · 拖完框 → 重算归属（`syncFrameMembership`），所以把卡片拖进/拖出框都能立刻生效
 *   · 四角可拉伸
 *
 * 画框自己不显示内容、只当容器，所以 `zIndex: -1`（建的时候设的），永远在内容下面。
 */
export default function FrameNodeView({ id, data, selected }: NodeProps<FrameNodeType>) {
  const syncFrameMembership = useRuntimeStore((s) => s.syncFrameMembership);
  const [title, setTitle] = useState(data.title);
  const [editingTitle, setEditingTitle] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setTitle(data.title);
  }, [data.title]);

  useEffect(() => {
    if (editingTitle) inputRef.current?.focus();
  }, [editingTitle]);

  /**
   * 拖完（或缩放完）再重算归属。
   *
   * 为什么不实时算：拖动过程中每帧改一次 `parentId` 会让 React Flow 反复重建节点，
   * 手感会明显发涩；而且拖动中途的"半进半出"本来也不该改变归属。
   */
  const resync = () => {
    // 让 React Flow 先把位置落到 store 上，再判归属
    requestAnimationFrame(() => syncFrameMembership(id));
  };

  return (
    <div
      className={`frame-node${selected ? " is-selected" : ""}`}
      data-node-view-wrapper
      data-canvas-frame-id={id}
      data-frame-id={id}
      data-node-state={selected ? "selected" : "idle"}
      style={{ background: data.fill, borderColor: data.stroke }}
      onPointerUp={resync}
    >
      {/* 四角可拉伸；画框拉伸后归属要重算，所以同样在结束时同步 */}
      <NodeResizer
        isVisible={Boolean(selected)}
        minWidth={240}
        minHeight={180}
        lineClassName="frame-resize-line"
        handleClassName="frame-resize-handle"
        onResizeEnd={resync}
      />

      <div
        className="frame-title"
        // 这条标题栏就是画框的**拖拽把手**（对标原版 `canvas-frame-drag-handle`）。
        // 注意它**不能**带 `nodrag`：画框本体是 pointer-events:none（否则框住的内容点不到），
        // 所以整块画框只能靠这里拖。标了 nodrag 就等于把画框锁死，拖不动。
        data-testid={`frame-drag-${id}`}
        title="拖动这里移动画框（框住的节点会一起走）；双击改名"
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditingTitle(true);
        }}
      >
        {editingTitle ? (
          <input
            ref={inputRef}
            className="frame-title-input nodrag"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              setEditingTitle(false);
              if (title.trim() && title !== data.title) {
                useRuntimeStore.getState().patchNodeData(id, { title: title.trim() });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setTitle(data.title);
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <span className="frame-title-text">
            <Frame size={11} /> {data.title}
          </span>
        )}
      </div>
    </div>
  );
}
