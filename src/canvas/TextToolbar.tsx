import { useLayoutEffect, useState } from "react";
import { AlignCenter, AlignLeft, AlignRight, Frame, Type, X } from "lucide-react";
import { useRuntimeStore } from "./runtimeStore";
import {
  TEXT_STYLE_LIMITS,
  normalizeTextStyle,
  sizeModeOf,
  supportsTextStyle,
  type TextAlign,
  type TextWeight,
} from "./textStyle";

/**
 * 文字排版工具条（阶段 8.5，对标原版 `data-canvas-text-toolbar-popup`）。
 *
 * 原版把它做成**浮动在文字块上方的小面板**，而不是塞进主工具条 ——
 * 因为排版是"选中某个文字块之后才成立"的操作，跟画布级的工具不是一类。
 *
 * 面板只在**恰好选中一个**支持排版的节点时出现：
 * 多选时用户想要的是"一起挪/一起删"，这时候弹一排排版滑块只会挡路。
 */
export default function TextToolbar() {
  const nodes = useRuntimeStore((s) => s.nodes);
  const patchTextStyle = useRuntimeStore((s) => s.patchTextStyle);

  const selected = nodes.filter((n) => n.selected);
  const node = selected.length === 1 ? selected[0] : null;
  const supported = node ? supportsTextStyle(node.type) : false;

  /** 面板位置：贴着选中节点的上沿。 */
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!node || !supported) {
      setPos(null);
      return;
    }
    /**
     * 位置从**节点元素的实际矩形**算，不从 flow 坐标算 ——
     * flow 坐标还要过一遍视口变换（平移 + 缩放），自己算一遍就等于把
     * React Flow 的变换逻辑抄一遍，抄错了面板就会飘走。
     * 拖动/缩放时靠 rAF 轮询跟随，简单且不会漏掉任何一种引起移动的操作。
     */
    let raf = 0;
    const follow = () => {
      const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${node.id}"]`);
      if (el) {
        const rect = el.getBoundingClientRect();
        setPos({ left: rect.left + rect.width / 2, top: rect.top });
      }
      raf = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(raf);
  }, [node, supported]);

  if (!node || !supported || !pos) return null;

  const style = normalizeTextStyle((node.data as { textStyle?: never }).textStyle);
  const mode = sizeModeOf(style);

  return (
    <div
      className="text-toolbar"
      data-testid="text-toolbar"
      data-canvas-text-toolbar-popup
      style={{ left: pos.left, top: Math.max(46, pos.top - 46) }}
    >
      <span className="text-toolbar-title">
        <Type size={12} /> 文字
      </span>

      <div className="text-toolbar-group" title="布局：文字在块里的对齐方式">
        {(
          [
            ["left", AlignLeft, "左对齐"],
            ["center", AlignCenter, "居中"],
            ["right", AlignRight, "右对齐"],
          ] as Array<[TextAlign, typeof AlignLeft, string]>
        ).map(([value, Icon, hint]) => (
          <button
            key={value}
            className={`text-tool-btn${style.align === value ? " on" : ""}`}
            data-text-align={value}
            title={hint}
            onClick={() => patchTextStyle({ align: value })}
          >
            <Icon size={13} />
          </button>
        ))}
      </div>

      <span className="text-toolbar-sep" />

      <label className="text-tool-field" title="字距（em，可负：中文大字标题收紧更精神）">
        <span>字距</span>
        <input
          type="range"
          data-testid="text-letter-spacing"
          min={TEXT_STYLE_LIMITS.letterSpacing.min}
          max={TEXT_STYLE_LIMITS.letterSpacing.max}
          step={TEXT_STYLE_LIMITS.letterSpacing.step}
          value={style.letterSpacing}
          onChange={(e) => patchTextStyle({ letterSpacing: Number(e.target.value) })}
        />
        <em>{style.letterSpacing.toFixed(3)}</em>
      </label>

      <label className="text-tool-field" title="行高倍数">
        <span>行高</span>
        <input
          type="range"
          data-testid="text-line-height"
          min={TEXT_STYLE_LIMITS.lineHeight.min}
          max={TEXT_STYLE_LIMITS.lineHeight.max}
          step={TEXT_STYLE_LIMITS.lineHeight.step}
          value={style.lineHeight}
          onChange={(e) => patchTextStyle({ lineHeight: Number(e.target.value) })}
        />
        <em>{style.lineHeight.toFixed(2)}</em>
      </label>

      <label className="text-tool-field" title="字号（px）">
        <span>字号</span>
        <input
          type="range"
          data-testid="text-font-size"
          min={TEXT_STYLE_LIMITS.fontSize.min}
          max={TEXT_STYLE_LIMITS.fontSize.max}
          step={TEXT_STYLE_LIMITS.fontSize.step}
          value={style.fontSize}
          onChange={(e) => patchTextStyle({ fontSize: Number(e.target.value) })}
        />
        <em>{style.fontSize}px</em>
      </label>

      <div className="text-toolbar-group" title="字重">
        {([400, 500, 600] as TextWeight[]).map((w) => (
          <button
            key={w}
            className={`text-tool-btn is-num${style.fontWeight === w ? " on" : ""}`}
            data-text-weight={w}
            onClick={() => patchTextStyle({ fontWeight: w })}
          >
            {w === 400 ? "常规" : w === 500 ? "中黑" : "加粗"}
          </button>
        ))}
      </div>

      <label className="text-tool-field" title="边框宽度（px，给文字块一圈外框）">
        <span>边框</span>
        <input
          type="range"
          data-testid="text-border-width"
          min={TEXT_STYLE_LIMITS.borderWidth.min}
          max={TEXT_STYLE_LIMITS.borderWidth.max}
          step={TEXT_STYLE_LIMITS.borderWidth.step}
          value={style.borderWidth}
          onChange={(e) => patchTextStyle({ borderWidth: Number(e.target.value) })}
        />
        <em>{style.borderWidth}px</em>
      </label>

      <span className="text-toolbar-sep" />

      <div className="text-toolbar-group" title="尺寸：随内容自适应，还是固定住不给它变">
        <button
          className={`text-tool-btn${mode === "auto" ? " on" : ""}`}
          data-text-size="auto"
          title="自动宽高：块随内容撑开"
          onClick={() => patchTextStyle({ autoWidth: true, autoHeight: true })}
        >
          自动
        </button>
        <button
          className={`text-tool-btn${mode === "fixed" ? " on" : ""}`}
          data-text-size="fixed"
          title="固定尺寸：块的宽高不再随内容变化"
          onClick={() => patchTextStyle({ autoWidth: false, autoHeight: false })}
        >
          <Frame size={11} /> 固定
        </button>
      </div>

      <button
        className="text-tool-btn"
        data-testid="text-reset"
        title="恢复默认排版"
        onClick={() =>
          patchTextStyle({
            align: "left",
            letterSpacing: 0,
            lineHeight: 1.6,
            fontSize: 13,
            fontWeight: 400,
            borderWidth: 0,
            autoWidth: false,
            autoHeight: false,
          })
        }
      >
        <X size={12} />
      </button>
    </div>
  );
}
