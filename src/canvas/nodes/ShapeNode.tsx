import { useEffect, useRef, useState } from "react";
import { Circle, Pencil, Square, Type } from "lucide-react";
import type { NodeProps } from "@xyflow/react";
import type { EllipseNode as EllipseNodeType, RectNode as RectNodeType } from "../types";
import { useNodeActions } from "../useNodeActions";
import { flipTransform } from "../layers";
import { DEFAULT_TEXT_STYLE, normalizeTextStyle, textStyleToCss } from "../textStyle";

/**
 * 形状节点（阶段 8.3，对标原版 `data-shape-kind`）。
 *
 * 矩形与椭圆共用一个渲染器：数据形状一致，只有画法不同。
 * 形状里可以直接写文字（双击进入编辑）—— 这是设计画布里最常见的用法：
 * 一个色块加一行标题，比"卡片 + 标题栏"更贴近真实排版稿。
 *
 * 形状不走 `NodeView` 的头/体结构，而是整块当成画面：
 * 因为它是"设计元素"，多一个标题栏就不像设计稿了。
 */
export default function ShapeNodeView({ id, type, data, selected }: NodeProps<RectNodeType | EllipseNodeType>) {
  const { beginEdit, setData } = useNodeActions();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.text);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setDraft(data.text);
  }, [data.text]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== data.text) {
      beginEdit(id);
      setData(id, { text: draft });
    }
  };

  const isRect = type === "rect";
  const ts = normalizeTextStyle(data.textStyle);
  const style: React.CSSProperties = {
    background: data.fill || "transparent",
    border: `${data.strokeWidth}px solid ${data.stroke}`,
    borderRadius: isRect ? `${data.radius}px` : undefined,
    // 椭圆用 50% 圆角把矩形"揉"成椭圆：比 SVG 更省事，且能和文字一起居中
    ...(isRect ? {} : { borderRadius: "50%" }),
    color: "#e6edf3",
    transform: flipTransform(data),
  };

  /** 形状里的文字单独吃排版（形状自己的边框/圆角不受影响）。 */
  const textCss = textStyleToCss(data.textStyle, data.stroke);
  // 形状是"居中放置的文字块"，所以默认对齐沿用形状的居中；用户显式改过就以用户为准
  const textAlign = ts.align === DEFAULT_TEXT_STYLE.align ? "center" : ts.align;

  return (
    <div
      className={`shape-node${selected ? " is-selected" : ""}`}
      data-node-view-wrapper
      data-shape-kind={data.shape}
      data-node-state={selected ? "selected" : "idle"}
      style={style}
      onDoubleClick={(event) => {
        event.stopPropagation();
        setEditing(true);
      }}
    >
      <span className="shape-icon" aria-hidden>
        {isRect ? <Square size={10} /> : <Circle size={10} />}
      </span>

      {!editing ? (
        <button
          className="shape-edit nodrag"
          data-testid={`shape-edit-${id}`}
          title="编辑形状里的文字（双击形状也可以）"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          <Pencil size={10} />
        </button>
      ) : null}

      {editing ? (
        <textarea
          ref={inputRef}
          className="shape-input nodrag nowheel"
          data-testid={`shape-input-${id}`}
          value={draft}
          rows={2}
          placeholder="写点文字"
          onChange={(e) => {
            setDraft(e.target.value);
            beginEdit(id);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(data.text);
              setEditing(false);
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commit();
            }
          }}
        />
      ) : (
        <span className="shape-text" style={{ ...textCss, textAlign, width: "auto", border: "none" }}>
          {data.text || (
            <span className="shape-placeholder">
              <Type size={11} /> 双击写字
            </span>
          )}
        </span>
      )}
    </div>
  );
}
