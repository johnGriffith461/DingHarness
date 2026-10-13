import { Eraser, MousePointer2, Sparkles, Trash2, Undo2 } from "lucide-react";
import {
  MARKER_COLORS,
  MARKER_KIND_META,
  MARKER_KINDS,
  type MarkerKind,
  type MarkerStyle,
} from "./markers";

/**
 * 标记工具条（阶段 5.2）。
 *
 * 放在画布工具条下方单独一条，是因为标记与"画布模式（框选/点选/涂抹/平移）"
 * 是两套互斥的意图：选中标记工具时画布模式让位，反之亦然。
 * 合在一个工具条里会让"我现在点下去会发生什么"变得不清楚。
 */
export default function MarkerToolbar({
  tool,
  style,
  count,
  useAsPrompt,
  onToolChange,
  onStyleChange,
  onUndo,
  onClearAll,
  onTogglePrompt,
}: {
  tool: MarkerKind | null;
  style: MarkerStyle;
  count: number;
  useAsPrompt: boolean;
  onToolChange: (tool: MarkerKind | null) => void;
  onStyleChange: (style: MarkerStyle) => void;
  onUndo: () => void;
  onClearAll: () => void;
  onTogglePrompt: () => void;
}) {
  return (
    <div className="marker-toolbar" data-testid="marker-toolbar">
      <span className="marker-toolbar-label">标记</span>

      <button
        type="button"
        className={`marker-tool${tool === null ? " is-active" : ""}`}
        data-marker-tool="select"
        aria-label="退出标记模式" title="退出标记模式，回到选择"
        onClick={() => onToolChange(null)}
      >
        <MousePointer2 size={13} />
      </button>

      {MARKER_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          className={`marker-tool${tool === kind ? " is-active" : ""}`}
          data-marker-tool={kind}
          title={`${MARKER_KIND_META[kind].label}：${MARKER_KIND_META[kind].hint}`}
          onClick={() => onToolChange(tool === kind ? null : kind)}
        >
          {MARKER_KIND_META[kind].label}
        </button>
      ))}

      <span className="marker-sep" />

      <span className="marker-colors">
        {MARKER_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`marker-color${style.color === color ? " is-active" : ""}`}
            data-marker-color={color}
            style={{ background: color }}
            title={`颜色 ${color}`}
            onClick={() => onStyleChange({ ...style, color })}
          />
        ))}
      </span>

      <input
        className="marker-width"
        type="range"
        min={1}
        max={12}
        step={1}
        value={style.width}
        title={`线宽 ${style.width}`}
        onChange={(e) => onStyleChange({ ...style, width: Number(e.target.value) })}
      />

      <span className="marker-sep" />

      <button
        type="button"
        className="marker-tool"
        data-testid="marker-undo"
        aria-label="撤销上一笔" title="撤销上一笔"
        disabled={count === 0}
        onClick={onUndo}
      >
        <Undo2 size={13} />
      </button>
      <button
        type="button"
        className="marker-tool"
        data-testid="marker-clear"
        aria-label="清空全部标记" title="清空全部标记"
        disabled={count === 0}
        onClick={onClearAll}
      >
        <Trash2 size={13} />
      </button>

      <span className="marker-sep" />

      <button
        type="button"
        className={`marker-prompt${useAsPrompt ? " is-on" : ""}`}
        data-testid="marker-prompt"
        title={
          useAsPrompt
            ? "生成时会把这些标记当成要求（点一下关掉）"
            : "生成时不使用标记（点一下打开）"
        }
        onClick={onTogglePrompt}
      >
        <Sparkles size={12} /> <span className="marker-prompt-text">标记当提示词</span>
      </button>

      <span className="marker-count" data-testid="marker-count" title="当前标记数量">
        <Eraser size={11} /> {count}
      </span>
    </div>
  );
}
