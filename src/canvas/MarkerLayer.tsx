import { ViewportPortal } from "@xyflow/react";
import type { Marker } from "./markers";
import {
  arrowGeometry,
  ellipseAttrs,
  markerStrokeWidth,
  maskAttrs,
  numberBadgeRadius,
  rectAttrs,
  smoothPath,
} from "./markerGeometry";

/**
 * 标记层渲染（阶段 5.1 / 5.2）。
 *
 * 放在 `ViewportPortal` 里，所以坐标直接用画布坐标 —— 平移缩放时标记跟着走，
 * 不需要自己做坐标换算。整层 `pointer-events: none`，命中测试由
 * `useMarkerDraw` 在容器层面用几何算（和画布选择层同一套做法）。
 */
export default function MarkerLayer({ markers }: { markers: Marker[] }) {
  if (markers.length === 0) return null;

  return (
    <ViewportPortal>
      <svg className="marker-layer" width={1} height={1} overflow="visible">
        {markers.map((marker) => (
          <MarkerShape key={marker.id} marker={marker} />
        ))}
      </svg>
    </ViewportPortal>
  );
}

function MarkerShape({ marker }: { marker: Marker }) {
  const sw = markerStrokeWidth(marker);
  const common = {
    stroke: marker.color,
    strokeWidth: sw,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };
  const selected = marker.selected ? " is-selected" : "";
  const cls = `marker-shape marker-${marker.kind}${selected}`;
  const halo = marker.selected ? { filter: "drop-shadow(0 0 4px rgba(255,255,255,.85))" } : undefined;

  switch (marker.kind) {
    case "rect": {
      const box = rectAttrs(marker.from, marker.to);
      return <rect className={cls} style={halo} x={box.x} y={box.y} width={box.width} height={box.height} rx={6} {...common} />;
    }
    case "ellipse": {
      const e = ellipseAttrs(marker.from, marker.to);
      return <ellipse className={cls} style={halo} cx={e.cx} cy={e.cy} rx={e.rx} ry={e.ry} {...common} />;
    }
    case "arrow": {
      const g = arrowGeometry(marker.from, marker.to, sw);
      return (
        <g className={cls} style={halo}>
          <line x1={g.line.x1} y1={g.line.y1} x2={g.line.x2} y2={g.line.y2} {...common} />
          <polyline points={g.head.map((p) => `${p.x},${p.y}`).join(" ")} fill={marker.color} stroke="none" />
        </g>
      );
    }
    case "scratch":
    case "highlight": {
      const points = marker.trail ?? [marker.from, marker.to];
      const opacity = marker.kind === "highlight" ? 0.32 : 1;
      return (
        <path
          className={cls}
          style={halo}
          d={smoothPath(points)}
          opacity={opacity}
          {...common}
          strokeWidth={marker.kind === "highlight" ? sw * 4 : sw}
        />
      );
    }
    case "text":
      return (
        <g className={cls} style={halo}>
          <text x={marker.from.x} y={marker.from.y} fill={marker.color} fontSize={13} fontWeight={600}>
            {marker.text ?? "批注"}
          </text>
        </g>
      );
    case "number": {
      const r = numberBadgeRadius(marker);
      return (
        <g className={cls} style={halo}>
          <circle cx={marker.from.x} cy={marker.from.y} r={r} fill={marker.color} opacity={0.92} />
          <text
            x={marker.from.x}
            y={marker.from.y + r * 0.36}
            fill="#0b1220"
            fontSize={r * 1.1}
            fontWeight={700}
            textAnchor="middle"
          >
            {marker.order ?? 1}
          </text>
        </g>
      );
    }
    case "mask": {
      const box = maskAttrs(marker);
      return <rect className={cls} style={halo} x={box.x} y={box.y} width={box.width} height={box.height} fill="#0b1220" opacity={0.55} stroke="none" />;
    }
    default:
      return null;
  }
}
