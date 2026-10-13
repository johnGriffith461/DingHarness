import { useCallback, useRef, useState } from "react";
import type { XYPosition } from "@xyflow/react";
import {
  MARKER_KIND_META,
  MARKER_MIN_DRAG,
  type Marker,
  type MarkerKind,
  type MarkerPoint,
  type MarkerStyle,
  dragLongEnough,
  makeMarker,
  nextMarkerId,
  nextMarkerOrder,
  trailLongEnough,
} from "./markers";

/**
 * 标记绘制手势（阶段 5.2）。
 *
 * 与选择层的关系：同一块画布上只能有一个手势在跑。选中某个标记工具时，
 * 选择层的框选/涂抹让位（`CanvasRuntime` 不会同时激活两者），本 hook 接管指针；
 * 回到"选择"状态时本 hook 不做事。
 *
 * 命中测试用几何算而不是 DOM，因为标记层整层 `pointer-events: none`——
 * 这样标记永远不会挡住下面的节点交互。
 */

export type MarkerDrawState = {
  /** 正在画的标记（拖拽中，实时预览）。 */
  draft: Marker | null;
  /** 待输入文字的标记（批注/序号点完要打字）。 */
  editingId: string | null;
};

export type UseMarkerDrawResult = {
  draft: Marker | null;
  editingMarker: Marker | null;
  handlers: {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: () => void;
    onDoubleClick: () => void;
  };
  /** 提交文字（批注/序号点完打字）。 */
  commitText: (text: string) => void;
  cancelText: () => void;
};

export type UseMarkerDrawOptions = {
  /** 当前工具；null 表示不在标记模式。 */
  tool: MarkerKind | null;
  style: MarkerStyle;
  markers: Marker[];
  /** 客户端坐标 → 画布坐标。 */
  toFlow: (event: { clientX: number; clientY: number }) => XYPosition;
  onAdd: (marker: Marker) => void;
  /** 画完一条后是否继续用同一个工具（按住 Alt 时保留，便于连续标）。 */
  onDrawn: (keepTool: boolean) => void;
};

export function useMarkerDraw(options: UseMarkerDrawOptions): UseMarkerDrawResult {
  const [draft, setDraft] = useState<Marker | null>(null);
  const [editing, setEditing] = useState<Marker | null>(null);
  const activeRef = useRef(false);
  const trailRef = useRef<MarkerPoint[]>([]);
  /**
   * 回调全部经 ref 转发：绘制过程中每帧都会 setState，如果让 useCallback 依赖
   * `markers` / `style`，指针移动时回调标识会不停变化，反而引入额外的重渲染。
   */
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const finish = useCallback((marker: Marker, keepTool: boolean) => {
    optionsRef.current.onAdd(marker);
    optionsRef.current.onDrawn(keepTool);
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const { tool: currentTool } = optionsRef.current;
      if (!currentTool || event.button !== 0) return;
      // 输入框里的操作不抢
      const el = document.elementFromPoint(event.clientX, event.clientY);
      if (el?.closest("input, textarea, select, [contenteditable='true']")) return;

      event.stopPropagation();
      event.preventDefault();
      activeRef.current = true;

      const at = optionsRef.current.toFlow(event);
      const id = nextMarkerId(optionsRef.current.markers);
      trailRef.current = [at];
      setDraft(
        makeMarker(id, currentTool, at, at, optionsRef.current.style, {
          trail: currentTool === "scratch" || currentTool === "highlight" ? [at] : undefined,
          order: currentTool === "number" ? nextMarkerOrder(optionsRef.current.markers) : undefined,
        }),
      );
    },
    [],
  );

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!activeRef.current) return;
    const { tool: currentTool } = optionsRef.current;
    const at = optionsRef.current.toFlow(event);
    if (currentTool === "scratch" || currentTool === "highlight") {
      trailRef.current = [...trailRef.current, at];
      setDraft((prev) => (prev ? { ...prev, to: at, trail: trailRef.current } : prev));
      return;
    }
    setDraft((prev) => (prev ? { ...prev, to: at } : prev));
  }, []);

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!activeRef.current) return;
      activeRef.current = false;
      const { tool: currentTool } = optionsRef.current;
      const keepTool = event.altKey;
      const at = optionsRef.current.toFlow(event);
      const draftNow = draft;
      setDraft(null);

      if (!currentTool || !draftNow) return;

      if (currentTool === "scratch" || currentTool === "highlight") {
        if (!trailLongEnough(trailRef.current, MARKER_MIN_DRAG)) return;
        finish({ ...draftNow, to: at, trail: trailRef.current }, keepTool);
        trailRef.current = [];
        return;
      }

      if (currentTool === "text" || currentTool === "number") {
        // 单击类标记：先落位，再让用户打字（序号可以不打字，直接提交）
        if (currentTool === "number") {
          finish({ ...draftNow, to: at }, keepTool);
          return;
        }
        setEditing({ ...draftNow, to: at });
        return;
      }

      if (!dragLongEnough(draftNow.from, at)) return;
      finish({ ...draftNow, to: at }, keepTool);
    },
    [draft, finish],
  );

  const onPointerCancel = useCallback(() => {
    activeRef.current = false;
    setDraft(null);
    trailRef.current = [];
  }, []);

  const commitText = useCallback(
    (text: string) => {
      if (!editing) return;
      const body = text.trim();
      setEditing(null);
      if (!body) return;
      finish({ ...editing, text: body }, false);
    },
    [editing, finish],
  );

  const cancelText = useCallback(() => setEditing(null), []);

  return {
    draft,
    editingMarker: editing,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onDoubleClick: () => undefined,
    },
    commitText,
    cancelText,
  };
}

/** 给工具条用的简短说明。 */
export function toolHint(tool: MarkerKind | null): string {
  if (!tool) return "选择模式：可以拖节点、框选、编辑内容";
  return MARKER_KIND_META[tool].hint;
}
