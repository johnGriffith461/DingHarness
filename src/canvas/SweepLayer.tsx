import { useEffect, useRef, useState } from "react";
import { ViewportPortal, type XYPosition } from "@xyflow/react";
import type { SweepVisual } from "./useCanvasSelection";

/**
 * 选择层的可视化：
 *   · 框选 —— 虚线矩形（世界坐标，跟随平移缩放）
 *   · 涂抹选 —— 轨迹折线 + 笔尖
 *
 * 绘制放在 `ViewportPortal` 里，坐标直接用世界坐标，不必自己套变换。
 * **本组件不接管指针**（`pointer-events: none`）：手势由画布容器在捕获阶段决定归属，
 * 见 `useCanvasSelection`。给节点盖遮罩会挡住文本编辑与节点拖拽。
 */
export default function SweepLayer({
  sink,
  mode,
  showRubberBand,
  showTrail,
}: {
  sink: (fn: (state: SweepVisual) => void) => void;
  /** 用于在切换模式时清掉上一笔的残留。 */
  mode: string;
  /** 是否画选择矩形（框选）。 */
  showRubberBand: boolean;
  /** 是否画轨迹（涂抹选）。 */
  showTrail: boolean;
}) {
  const [visual, setVisual] = useState<SweepVisual>({ from: null, to: null, trail: [] });
  const sinkRef = useRef(sink);
  sinkRef.current = sink;

  useEffect(() => {
    setVisual({ from: null, to: null, trail: [] });
  }, [mode]);

  useEffect(() => {
    sinkRef.current(setVisual);
  }, []);

  const rect =
    showRubberBand && visual.from && visual.to
      ? {
          x: Math.min(visual.from.x, visual.to.x),
          y: Math.min(visual.from.y, visual.to.y),
          width: Math.abs(visual.to.x - visual.from.x),
          height: Math.abs(visual.to.y - visual.from.y),
        }
      : null;

  const trailPoints =
    showTrail && visual.trail.length >= 2
      ? visual.trail.map((p) => `${p.x},${p.y}`).join(" ")
      : null;
  const trailHead = showTrail ? visual.trail[visual.trail.length - 1] : undefined;

  if (!rect && !trailPoints) return null;

  return (
    <ViewportPortal>
      <svg className="sweep-layer" aria-hidden>
        {rect ? <rect className="sweep-rect" {...rect} /> : null}
        {trailPoints ? <polyline className="smear-trail" points={trailPoints} /> : null}
        {trailPoints && trailHead ? (
          <circle className="smear-head" cx={trailHead.x} cy={trailHead.y} r={5} />
        ) : null}
      </svg>
    </ViewportPortal>
  );
}

/** 选择层里用到的世界坐标点类型（导出给调用方约束 sink 参数）。 */
export type { XYPosition };
