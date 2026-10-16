import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, Pen, Trash2 } from "lucide-react";
import type { NodeProps } from "@xyflow/react";
import type { WhiteboardData, WhiteboardNode as WhiteboardNodeType, WhiteboardStroke } from "../types";
import { NodeView } from "./NodeView";
import NodeGenerationBar from "./NodeGenerationBar";
import { useNodeActions } from "../useNodeActions";

/**
 * 白板节点（PLAN 2.9）：Canvas 2D 手绘 + 擦除。
 *
 * 坐标：笔迹存**画布内坐标**（相对节点左上角），所以节点被拖动/缩放后笔迹仍然贴合。
 * 画布按设备像素比放大（高分屏不糊），并且每次 resize 后重放已有笔迹 —— 改
 * `canvas.width` 会清空画布，这一步不能省。
 *
 * 性能：绘制过程中只往 canvas 上画、不每次 setState（每帧 setState 会掉帧），
 * 抬笔后节流 500ms 把笔迹同步回 store，交给撤销栈与阶段 4 的快照。
 */

const PALETTE = ["#60a5fa", "#34d399", "#fbbf24", "#f87171", "#e5e7eb", "#a78bfa"];

/** 抬笔后多久把笔迹同步回 store。 */
const SYNC_DEBOUNCE_MS = 500;

function drawStroke(ctx: CanvasRenderingContext2D, stroke: WhiteboardStroke) {
  const { points, color, width } = stroke;
  if (points.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length - 1; i += 2) {
    ctx.lineTo(points[i], points[i + 1]);
  }
  ctx.stroke();
}

/** 线段相交判定（橡皮擦命中用）。 */
function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const cross = (ox: number, oy: number, px: number, py: number, qx: number, qy: number) =>
    (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** 某个点是否落在这一笔附近（橡皮擦）。 */
function strokeHit(stroke: WhiteboardStroke, x: number, y: number, radius: number): boolean {
  const p = stroke.points;
  if (p.length >= 2 && Math.hypot(p[0] - x, p[1] - y) < radius) return true;
  for (let i = 0; i + 3 < p.length; i += 2) {
    if (
      segmentsIntersect(
        x - radius,
        y - radius,
        x + radius,
        y + radius,
        p[i],
        p[i + 1],
        p[i + 2],
        p[i + 3],
      )
    ) {
      return true;
    }
  }
  return false;
}

export default function WhiteboardNodeView({ id, data, selected }: NodeProps<WhiteboardNodeType>) {
  const { beginEdit, setData } = useNodeActions();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const strokesRef = useRef<WhiteboardStroke[]>(data.strokes ?? []);
  const currentRef = useRef<WhiteboardStroke | null>(null);
  const drawingRef = useRef(false);
  const dirtyRef = useRef(false);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tool, setTool] = useState<WhiteboardData["tool"]>(data.tool ?? "pen");
  const [color, setColor] = useState(data.color);
  const [size, setSize] = useState(data.penWidth);
  const [strokeCount, setStrokeCount] = useState(strokesRef.current.length);
  const [hasSize, setHasSize] = useState(false);

  /** 画布尺寸 = 容器尺寸 × DPR，然后重放全部笔迹。 */
  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const rect = host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const s of strokesRef.current) drawStroke(ctx, s);
    if (currentRef.current) drawStroke(ctx, currentRef.current);
    setHasSize(h > 1);
  }, []);

  useEffect(() => {
    resize();
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => resize());
    ro.observe(host);
    return () => ro.disconnect();
  }, [resize]);

  // 外部改了笔迹（撤销 / 重做 / 换快照）就重置本地副本；本地正在画时以本地为准
  useEffect(() => {
    const next = data.strokes ?? [];
    if (!dirtyRef.current) {
      strokesRef.current = next;
      setStrokeCount(next.length);
      resize();
    }
  }, [data.strokes, resize]);

  useEffect(() => {
    setColor(data.color);
    setSize(data.penWidth);
    setTool(data.tool ?? "pen");
  }, [data.color, data.penWidth, data.tool]);

  /**
   * 把本地笔迹交回 store（定时器到点、以及**卸载**都走这里）。
   *
   * 抽成一处是因为卸载那条路新加的时候最容易写成第二份实现 ——
   * 而两份实现一开始一样、之后必然有一份忘了改（本仓反复清过这个形状）。
   */
  const commitStrokes = useCallback(() => {
    dirtyRef.current = false;
    const copy = strokesRef.current.map((s) => ({ ...s, points: [...s.points] }));
    setStrokeCount(copy.length);
    setData(id, { strokes: copy });
  }, [id, setData]);

  const flush = useCallback(() => {
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      syncTimer.current = null;
      commitStrokes();
    }, SYNC_DEBOUNCE_MS);
  }, [commitStrokes]);

  /**
   * ⚠️⚠️ **卸载时必须把本地笔迹交出去**（2026-10-16 审计 P28）。
   *
   * 原来这里只有 `clearTimeout` —— 于是"抬笔后 500ms 内卸载"的最后几笔**直接丢**：
   * 抬笔时写的还只是本地 `strokesRef`，store 那份要等定时器到点才更新。
   * 而节点卸载是**常态**而不是意外：`onlyRenderVisibleElements` 会把滚出视野的节点
   * 卸下来，画布面板一关更是整块消失 —— 用户看到的是"我明明画了那几笔，回来没了"。
   *
   * 与 blur 那条路走的是**同一个** `commitStrokes()`：一处写、两处调，
   * 不会出现"定时器那份带了某个字段、卸载那份没带"的漂移。
   */
  useEffect(
    () => () => {
      if (syncTimer.current) {
        clearTimeout(syncTimer.current);
        syncTimer.current = null;
      }
      if (dirtyRef.current) commitStrokes();
    },
    [commitStrokes],
  );

  /** 屏幕坐标 → 画布内坐标。 */
  const toLocal = (e: React.PointerEvent): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const erase = (x: number, y: number) => {
    const radius = Math.max(6, size * 2.5);
    const before = strokesRef.current.length;
    strokesRef.current = strokesRef.current.filter((s) => !strokeHit(s, x, y, radius));
    if (strokesRef.current.length !== before) {
      resize();
      setStrokeCount(strokesRef.current.length);
      flush();
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture?.(e.pointerId);
    drawingRef.current = true;
    dirtyRef.current = true;
    const { x, y } = toLocal(e);
    if (tool === "eraser") {
      erase(x, y);
      return;
    }
    currentRef.current = { tool: "pen", color, width: size, points: [x, y] };
    // 起手就落一个点，单击也能画出点
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { x, y } = toLocal(e);
    if (tool === "eraser") {
      erase(x, y);
      return;
    }
    const stroke = currentRef.current;
    if (!stroke) return;
    const n = stroke.points.length;
    const lastX = stroke.points[n - 2] ?? x;
    const lastY = stroke.points[n - 1] ?? y;
    stroke.points.push(x, y);
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    canvasRef.current?.releasePointerCapture?.(e.pointerId);
    if (tool === "pen" && currentRef.current) {
      // 只落了一个点也要留下一笔（半径 0 的线段画不出来，补成两点）
      const stroke = currentRef.current;
      if (stroke.points.length === 2) stroke.points.push(stroke.points[0] + 0.01, stroke.points[1]);
      strokesRef.current = [...strokesRef.current, stroke];
      currentRef.current = null;
      setStrokeCount(strokesRef.current.length);
      beginEdit(id);
    }
    flush();
  };

  const clearAll = () => {
    beginEdit(id);
    strokesRef.current = [];
    dirtyRef.current = false;
    setStrokeCount(0);
    resize();
    setData(id, { strokes: [] });
  };

  const pickTool = (next: WhiteboardData["tool"]) => {
    setTool(next);
    setData(id, { tool: next });
  };

  return (
    <NodeView
      title={data.title}
      icon={<Pen size={12} />}
      tag={`${strokeCount} 笔`}
      selected={selected}
      className="nv-whiteboard"
      fixedSize
      headActions={
        <>
          <button
            className={`nv-btn${tool === "pen" ? " on" : ""}`}
            onClick={() => pickTool("pen")}
            title="画笔"
          >
            <Pen size={11} />
          </button>
          <button
            className={`nv-btn${tool === "eraser" ? " on" : ""}`}
            onClick={() => pickTool("eraser")}
            title="橡皮擦"
          >
            <Eraser size={11} />
          </button>
          <button className="nv-btn" onClick={clearAll} aria-label="清空画布" title="清空画布">
            <Trash2 size={11} />
          </button>
        </>
      }
    >
      <div className="nv-board-bar nodrag">
        {PALETTE.map((c) => (
          <button
            key={c}
            className={`nv-swatch${color === c && tool === "pen" ? " on" : ""}`}
            style={{ background: c }}
            title={c}
            onClick={() => {
              setColor(c);
              pickTool("pen");
              setData(id, { color: c });
            }}
          />
        ))}
        <input
          className="nv-range"
          type="range"
          min={1}
          max={12}
          value={size}
          title="笔粗"
          onChange={(e) => {
            const v = Number(e.target.value);
            setSize(v);
            setData(id, { penWidth: v });
          }}
        />
      </div>
      <div className="nv-board-host nodrag nowheel" ref={hostRef}>
        <canvas
          ref={canvasRef}
          className={`nv-board-canvas${tool === "eraser" ? " is-eraser" : ""}`}
          data-ready={hasSize ? "1" : "0"}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>
      <NodeGenerationBar node={{ id, type: "whiteboard", data }} />
    </NodeView>
  );
}
