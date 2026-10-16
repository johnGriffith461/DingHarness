import { useEffect, useRef, useState } from "react";
import { Circle, Pencil, Square, Type } from "lucide-react";
import type { NodeProps } from "@xyflow/react";
import type { EllipseNode as EllipseNodeType, RectNode as RectNodeType } from "../types";
import { useNodeActions } from "../useNodeActions";
import { createEditBuffer, shouldCommitOnEnter } from "../textCommit";
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
  /**
   * 编辑缓冲（2026-10-16 审计 P27）：正文原来只在 blur 时提交，
   * 而画布开着 `onlyRenderVisibleElements` —— 形状被滚出视野/画布面板一关就**卸载**，
   * blur 永远不会来，刚打的字只存在于组件内部。
   * 现在 blur、回车、**卸载**三个出口都走同一份口径（`textCommit.ts`）。
   */
  const bufferRef = useRef<ReturnType<typeof createEditBuffer> | null>(null);
  if (bufferRef.current === null) {
    bufferRef.current = createEditBuffer((value) => {
      beginEdit(id);
      setData(id, { text: value });
    });
  }
  const buffer = bufferRef.current;
  /** 已落盘的那份正文（卸载清理里读不到新的 `data.text`，所以自己留一份）。 */
  const committedRef = useRef(data.text);

  useEffect(() => {
    setDraft(data.text);
    committedRef.current = data.text;
    buffer.reset(data.text);
  }, [data.text, buffer]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  /** 提交：blur / 回车 / 卸载都走这里（`flush` 幂等，重复调不会多打一个撤销点）。 */
  const commit = () => {
    setEditing(false);
    buffer.flush();
  };

  useEffect(
    () => () => {
      /* ⚠️ 卸载前把没提交的正文交出去（P27）：缓冲里没有未提交的值时它什么都不做 */
      buffer.flush();
    },
    [buffer],
  );

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
          aria-label="编辑形状里的文字" title="编辑形状里的文字（双击形状也可以）"
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
            buffer.set(e.target.value);
            beginEdit(id);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(data.text);
              /*
               * ⚠️ Esc 是**放弃**这一份草稿，所以要把缓冲一起回退（P27）：
               * 不回退的话，卸载时那个缓冲会把用户刚放弃的内容又写回去
               * —— "按了 Esc 却还是改了"会让下面那处卸载刷新看着像撤销失效。
               */
              buffer.reset(data.text);
              setEditing(false);
            }
            /*
             * ⚠️ 回车提交要用 IME 感知的判据（P27）：中文输入法里"回车选词"
             * 也是一次 Enter —— 原来会中途确认好几段，把拼音原文写进内容。
             */
            if (shouldCommitOnEnter({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) {
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
