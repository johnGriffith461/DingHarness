import { useCallback, useEffect, useRef } from "react";
import { useStoreApi, type InternalNode, type Node, type XYPosition } from "@xyflow/react";
import type { NodeLookup } from "@xyflow/system";
import { clientToFlowPosition, fromTransform } from "./viewport";
import { boxHitTest, clickHitTest, isMultiSelectKey, smearHitTest, toggleSelection } from "./selection";
import type { SelectionMode } from "./selection";
import { rafThrottle } from "@/utils/raf";

/**
 * 画布选择系统：框选 / 涂抹选共用一套指针处理，点选用 React Flow 自带行为。
 *
 * 为什么自研：React Flow 的框选只在指针**正好落在 pane 元素本身**时才启动
 * （`event.target === pane` 判断），压在 Background 网格、节点层或节点上起手都不会拉框，
 * 而且框选期间会摘掉 `onClick`，节点内容无法交互。涂抹选它根本没有。
 *
 * 实现方式：在画布容器上挂**捕获阶段**的指针处理器。
 *   · 起手落在节点内（或输入控件内）→ 直接放行，交给 React Flow 的节点拖拽/编辑
 *   · 起手落在空白处 → `stopPropagation` 由本模块独占这次手势，画选择框/轨迹
 * 用捕获阶段是为了抢在 React Flow 用 `pointerdownCapture` 抢占之前决定归属，
 * 同时不需要在节点上盖一层透明遮罩（那会挡住文本编辑与节点拖拽）。
 */

export type SweepApi = {
  /** 当前是否正在拖拽（覆盖层据此切换光标）。 */
  isSweeping: () => boolean;
  /** 挂到画布容器上的捕获阶段指针/鼠标处理器。 */
  handlers: {
    onPointerDownCapture: (event: React.PointerEvent<HTMLElement>) => void;
    onMouseDownCapture: (event: React.MouseEvent<HTMLElement>) => void;
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
    onPointerUpCapture: () => void;
    onMouseUpCapture: () => void;
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  };
  /** 覆盖层注册绘制回调。 */
  setSink: (sink: (state: SweepVisual) => void) => void;
  /**
   * 让选择层暂时失效（标记模式下用）。
   * 选择层用的是捕获阶段的指针处理，如果不显式让位，它会先把这次手势吃掉，
   * 表现就是"切到标记工具后头几下画不出来"。
   */
  setInert: (next: boolean) => void;
};
/** 覆盖层要画的东西（全部是世界坐标）。 */
export type SweepVisual = {
  from: XYPosition | null;
  to: XYPosition | null;
  trail: XYPosition[];
};

type SweepOptions = {
  mode: SelectionMode;
  /** 取 React Flow 内部节点表。 */
  getLookup: () => NodeLookup<InternalNode<Node>>;
  /** 取当前已选中的节点 id。 */
  getSelected: () => string[];
  /** 选中集落库（整体替换，不是追加）。 */
  onSelect: (ids: string[]) => void;
};

/** 拖拽超过这个像素数才算"拉框"，否则交给点选。 */
const DRAG_THRESHOLD_PX = 4;

/** 一次手势的归属。 */
type Ownership = "node" | "input" | "sweep";

export function useCanvasSelection({
  mode,
  getLookup,
  getSelected,
  onSelect,
}: SweepOptions): SweepApi {
  const store = useStoreApi();
  const draggingRef = useRef(false);
  const anchorRef = useRef<XYPosition | null>(null);
  const anchorClientRef = useRef<XYPosition | null>(null);
  const baseRef = useRef<string[]>([]);
  const trailRef = useRef<XYPosition[]>([]);
  const sinkRef = useRef<((state: SweepVisual) => void) | null>(null);
  const paramsRef = useRef({ mode, getLookup, getSelected, onSelect });
  paramsRef.current = { mode, getLookup, getSelected, onSelect };
  /** 本次手势是否从输入控件上借来的（借来的话要等指针移动才真正接管）。 */
  const relaxInputRef = useRef(false);
  /** 是否让位给别的工具（标记模式）。 */
  const inertRef = useRef(false);

  const toFlow = useCallback(
    (event: { clientX: number; clientY: number }): XYPosition => {
      const { domNode, transform } = store.getState();
      return clientToFlowPosition(
        { x: event.clientX, y: event.clientY },
        domNode?.getBoundingClientRect() ?? null,
        fromTransform(transform),
      );
    },
    [store],
  );

  const emit = useCallback((from: XYPosition | null, to: XYPosition | null) => {
    sinkRef.current?.({ from, to, trail: trailRef.current });
  }, []);

  /** 每帧一次：更新轨迹并重算命中集。 */
  const sweep = useRef(
    rafThrottle((current: XYPosition) => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const { mode: currentMode, getLookup: lookup, onSelect: select } = paramsRef.current;
      if (currentMode === "smear") trailRef.current = [...trailRef.current, current];
      emit(anchor, current);
      select(
        currentMode === "smear"
          ? Array.from(new Set([...baseRef.current, ...smearHitTest(anchor, current, lookup())]))
          : boxHitTest(anchor, current, lookup()),
      );
    }),
  ).current;

  /**
   * 判断这次按下的归属。
   *
   * 用 `elementFromPoint` 而不是 `event.target`：节点外壳的间隙、SVG 网格、pane 本身
   * 都可能是 target，而用户眼里的"是不是点在节点上"只取决于指针下方的实际元素。
   *
   * 三种归属：
   *   · 输入控件（textarea / input / select / contenteditable）→ 归输入控件，选择层完全不参与。
   *     涂抹/框选模式想划过文本区域时，选择层会向输入控件"借"这次手势（见 `onPointerDownCapture`
   *     里的 `relaxInput`）：指针一旦移动就转成选择，没移动就点下去原位插入光标。
   *   · 节点外壳、连接点 → 归节点（拖动、连线、点选）。
   *   · 其余（含 Background 网格、pane 空白）→ 归选择层。
   */
  const decide = useCallback(
    (event: { clientX: number; clientY: number }): Ownership => {
      const el = document.elementFromPoint(event.clientX, event.clientY);
      if (!el) return "sweep";
      if (el.closest("input, textarea, select, [contenteditable='true']")) return "input";
      if (el.closest(".react-flow__node, .react-flow__handle")) return "node";
      return "sweep";
    },
    [],
  );

  const onPointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // 标记模式下手势归标记层（两者互斥，见 useMarkerDraw）
      if (inertRef.current) return;
      const { mode: currentMode } = paramsRef.current;
      if (currentMode !== "box" && currentMode !== "smear") return;

      const ownership = decide(event);
      if (ownership === "node") return;
      /**
       * 起手落在输入控件上时先不抢：等指针真的移动了再接管（`relaxInput`）。
       * 这样"点一下文本"仍是正常编辑，"按住划过文本"能转成涂抹/框选。
       */
      const relaxInput = ownership === "input";

      const anchor = toFlow(event);
      anchorRef.current = anchor;
      anchorClientRef.current = { x: event.clientX, y: event.clientY };
      baseRef.current = getSelected();
      trailRef.current = [anchor];
      draggingRef.current = false;
      relaxInputRef.current = relaxInput;
      emit(anchor, anchor);
      // 空白处起手可以直接拦住；输入控件要先放行，否则点不进光标
      if (!relaxInput) event.stopPropagation();
    },
    [decide, emit, getSelected, toFlow],
  );
  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!anchorRef.current) return;
      if (event.buttons === 0) {
        // 指针在窗口外松开时收不到 pointerup，这里补收尾
        anchorRef.current = null;
        anchorClientRef.current = null;
        draggingRef.current = false;
        relaxInputRef.current = false;
        return;
      }
      if (!draggingRef.current) {
        const start = anchorClientRef.current;
        if (!start) return;
        const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
        if (moved < DRAG_THRESHOLD_PX) return;
        draggingRef.current = true;
        // 拖拽期间独占指针，避免中途被其它元素抢走
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }
      event.stopPropagation();
      sweep(toFlow(event));
    },
    [sweep, toFlow],
  );

  const end = useCallback(() => {
    anchorRef.current = null;
    anchorClientRef.current = null;
    baseRef.current = [];
    trailRef.current = [];
    draggingRef.current = false;
    relaxInputRef.current = false;
    emit(null, null);
  }, [emit]);

  useEffect(() => {
    if (mode === "pan" || mode === "point") end();
  }, [end, mode]);

  const setSink = useCallback((sink: (state: SweepVisual) => void) => {
    sinkRef.current = sink;
  }, []);

  /**
   * 点选模式下的多选。
   *
   * React Flow 自带的多选在"受控节点数组"下不生效（`multiSelectionActive` 没落到实处），
   * 所以自己接管：按 Ctrl / Cmd / Shift 点击节点就切换它的选中态。
   *
   * 关键点：**只拦 pointerdown 不够**。React Flow 的节点点选同时挂在 pointerdown /
   * mousedown / click 上，拦掉第一个之后，后面的 mousedown / click 仍会触发它自己的
   * `handleNodeClick` → 把整份选择替换成"只有被点的那一个"。所以这三个事件都要处理。
   *
   * 幂等做法：记住上一次真正执行过的命中节点与时间，同一个节点在短窗口内再来一次
   * 就只拦截、不再切换（见 `lastToggleRef`）。
   *
   * 注意**不要在 mouseup / pointerup 上清掉这个记录**：实测 `mouseup` 的捕获阶段
   * 早于 `click`，抬手时清掉就等于没有去重，click 又切换一次（选中→立刻取消）。
   * 只靠时间窗口去重即可。
   */
  const lastToggleRef = useRef<{ node: string; at: number } | null>(null);

  const multiSelectBefore = useCallback(
    (
      event: React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>,
    ): boolean => {
      if (inertRef.current) return false;
      if (paramsRef.current.mode !== "point") return false;
      if (!isMultiSelectKey(event)) return false;
      const hit = clickHitTest(toFlow(event), paramsRef.current.getLookup(), 3);
      if (hit.length === 0) return false;

      // 拦住下游，别让它替换整份选择
      event.stopPropagation();
      event.preventDefault();

      const key = hit.slice().sort().join(",");
      const last = lastToggleRef.current;
      const now = Date.now();
      if (last && last.node === key && now - last.at < 800) return true;

      lastToggleRef.current = { node: key, at: now };
      paramsRef.current.onSelect(toggleSelection(paramsRef.current.getSelected(), hit));
      return true;
    },
    [toFlow],
  );

  const noop = useCallback(() => undefined, []);

  return {
    isSweeping: () => draggingRef.current,
    setInert: (next: boolean) => {
      inertRef.current = next;
    },
    handlers: {
      onPointerDownCapture,
      onMouseDownCapture: multiSelectBefore,
      onClickCapture: multiSelectBefore,
      onPointerUpCapture: noop,
      onMouseUpCapture: noop,
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: end,
    },
    setSink,
  };
}

/** 点选模式下，单击画布空白处取消选择（React Flow 只在指针位于 pane 本身时才发那一下点击）。 */
export function useBlankClickClear(mode: SelectionMode, selectNodes: (ids: string[]) => void): void {
  useEffect(() => {
    if (mode !== "point") return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".react-flow__node, .canvas-toolbar, .canvas-statusbar, .side, .titlebar")) {
        return;
      }
      if (!target.closest(".canvas-flow")) return;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      if (hit?.closest(".react-flow__node")) return;
      selectNodes([]);    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [mode, selectNodes]);
}
