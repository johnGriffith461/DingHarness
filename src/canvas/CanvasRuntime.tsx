import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  addEdge,
  useOnViewportChange,
  useReactFlow,
  useStoreApi,
  type Connection,
  type Edge,
  type EdgeChange,
  type InternalNode,
  type Node,
  type NodeChange,
  type Viewport,
  type XYPosition,
} from "@xyflow/react";
import type { NodeLookup } from "@xyflow/system";
import type { ShellBridge } from "@shared/ipc";
import { nodeTypes } from "./nodes";
import CanvasToolbar from "./CanvasToolbar";
import CanvasStatusBar from "./CanvasStatusBar";
import SweepLayer from "./SweepLayer";
import {
  modeDrawsRubberBand,
  modeDrawsTrail,
  selectionModeProps,
} from "./selection";
import type { SelectionMode } from "./selection";
import { useCanvasSelection, useBlankClickClear } from "./useCanvasSelection";
import { usePersistence } from "./usePersistence";
import { useMarkerDraw } from "./useMarkerDraw";
import MarkerLayer from "./MarkerLayer";
import MarkerTextInput from "./MarkerTextInput";
import MarkerToolbar from "./MarkerToolbar";
import VersionHistoryPanel from "./VersionHistoryPanel";
import LayerPanel from "./LayerPanel";
import TextToolbar from "./TextToolbar";
import { sizeToWH } from "@shared/imageSize";
import BottomToolbar from "./BottomToolbar";
import NodeContextMenu from "./NodeContextMenu";
import GeneratePanel from "./GeneratePanel";
import type { MarkerKind } from "./markers";
import { markersAsPrompt } from "./markers";
import { matchShortcut } from "./shortcuts";
import { parseClipboard, planPaste, serializeClipboard } from "./clipboard";
import type { Rect } from "./nodeRect";
import { NODE_KIND_META } from "./types";
import { useRuntimeStore } from "./runtimeStore";
import type { RuntimeState } from "./runtimeStore";
import type { CanvasNode, NodeKind } from "./types";
import { generateNodeFromSelection, type GenerateIntent } from "./canvasGenerate";
import { useChatStore } from "@/ai/chatStore";

/**
 * 画布宿主（对标原版 `CanvasReactRuntimeProvider` + 无限画布）。
 *
 * 阶段 1 职责：把 React Flow 实例、自研 store、撤销栈、四种工具模式缝在一起。
 * 不在这里做的事：节点内容渲染（`nodes/`）、持久化（阶段 4）、AI 生成（阶段 3）。
 *
 * 视口由 React Flow 自己持有，只在 `useOnViewportChange(end)` 时写回 store ——
 * 既不每帧推高修订号，又给阶段 4 留下"快照里带视口"的落点。
 */

/** 对应 React Flow 的 NodeChange<Node>；store 侧再收窄到 CanvasNode。 */
type FlowChange = NodeChange<Node>;

/** 只取视口的三个数，避免把 React Flow 内部的 viewport 结构泄漏进 store。 */
function extractViewport(viewport: { x: number; y: number; zoom: number }): Viewport {
  return { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
}

export default function CanvasRuntime() {
  const nodes = useRuntimeStore((s) => s.nodes);
  const edges = useRuntimeStore((s) => s.edges);
  const revision = useRuntimeStore((s) => s.revision);
  const history = useRuntimeStore((s) => s.history);
  const applyNodeChanges = useRuntimeStore((s) => s.applyNodeChanges);
  const applyEdgeChangesStore = useRuntimeStore((s) => s.applyEdgeChanges);
  const selectNodes = useRuntimeStore((s) => s.selectNodes);
  const addNodeAt = useRuntimeStore((s) => s.addNodeAt);
const syncAllFrames = useRuntimeStore((s) => s.syncAllFrames);
  const generateState = useRuntimeStore((s) => s.generateState);
  const generateError = useRuntimeStore((s) => s.generateError);
  const setGenerateState = useRuntimeStore((s) => s.setGenerateState);
const patchNodeData = useRuntimeStore((s) => s.patchNodeData);
  const commitHistory = useRuntimeStore((s) => s.commitHistory);
  const undoHistory = useRuntimeStore((s) => s.undoHistory);
  const redoHistory = useRuntimeStore((s) => s.redoHistory);
  const setViewport = useRuntimeStore((s) => s.setViewport);
  const resetToSample = useRuntimeStore((s) => s.resetToSample);

  const [mode, setMode] = useState<SelectionMode>("box");
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  /** 一次连续拖动只在起步处打一个撤销点。 */
  const dragStartedRef = useRef(false);
  /** 初始视口只在挂载时读一次，之后交给 React Flow 自己持有。 */
  const initialViewportRef = useRef<Viewport>(useRuntimeStore.getState().viewport);

  const rf = useReactFlow();
  const storeApi = useStoreApi();
  /**
   * 选中数量从**我们自己的 store** 算，而不是 React Flow 的 `nodeLookup`：
   * 受控数组下 `nodeLookup` 里的 `selected` 标志更新时间不确定，
   * 直接读它会出现"明明选中了、工具条上的按钮还是灰的"。
   */
  const selectedCount = useMemo(() => nodes.filter((n) => n.selected).length, [nodes]);

  /**
   * 取当前选中集：**读 store 的实时状态**（`storeApi.getState()`），
   * 不能用渲染时捕获的 `nodeLookup` —— 那是上一次渲染的快照。
   * 多选时我们改完选择会立刻触发 React Flow 的 `onSelectionChange`，
   * 那一刻若读到旧快照，就会把刚选中的东西又清掉（实测表现为"怎么点都选不中"）。
   */
  const getLookup = useMemo(
    () => () => storeApi.getState().nodeLookup as unknown as NodeLookup<InternalNode<Node>>,
    [storeApi],
  );
  const getSelected = useMemo(
    () => () =>
      Array.from(storeApi.getState().nodeLookup as unknown as Map<string, InternalNode<Node>>)
        .filter(([, node]) => node.selected)
        .map(([id]) => id),
    [storeApi],
  );
  const onSelectionChange = useCallback((ids: string[]) => selectNodes(ids), [selectNodes]);
  const selection = useCanvasSelection({
    mode,
    getLookup,
    getSelected,
    onSelect: onSelectionChange,
  });
  useBlankClickClear(mode, selectNodes);

  /* ---------- 持久化：载入 / 自动保存 / 崩溃恢复提示 ---------- */
  const { saveState, recoveryNote, clearRecoveryNote, saveNow } = usePersistence();

  /* ---------- 标记层（阶段 5） ---------- */

  /** 当前标记工具。放在组件里而不是 store 里：它是"当下手上拿的笔"，
   * 属于界面状态，不该进撤销栈、也不该被持久化。
   */
  const [markerTool, setMarkerTool] = useState<MarkerKind | null>(null);
  /** 版本历史面板是否打开（对标原版 `canvas_versions_*`）。 */
  const [versionsOpen, setVersionsOpen] = useState(false);
  /** 图层面板是否打开（对标原版 `data-canvas-order` 的图层面板）。 */
  const [layersOpen, setLayersOpen] = useState(false);
  /** 正在导出：此刻浮层全部隐藏，截出来的才是"作品"而不是"界面照"。 */
  const [exporting, setExporting] = useState(false);
  /** 生成面板开着哪一个（图片 / 视频 / 都关）。 */
  const [genKind, setGenKind] = useState<"image" | "video" | null>(null);
  /** 右键点中的节点与弹出坐标（null = 没开）。 */
  const [nodeMenu, setNodeMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null);

  /**
   * 生成完成 → 落成画布上的图片节点（对标原版"生成物即节点"）。
   *
   * 图片本身在磁盘上（`dshasset://<文件名>`），文档里只留这个 url 与提示词 ——
   * 不把 3 MB 的 base64 塞进快照，否则版本历史会被撑爆。
   */
  const onGenDone = useCallback(
    (result: { name: string; url: string; prompt: string; model: string; size?: string }) => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      const center = {
        x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
        y: (rect?.top ?? 0) + (rect?.height ?? 0) / 2,
      };
      const at = rf.screenToFlowPosition(center);
      commitHistory();
      const created = addNodeAt("image", at);

      // sizeToWH 给的是 {w,h}（规格那边的口径），而节点数据用的是 {width,height}
      const wh = result.size ? sizeToWH(result.size) : null;
      patchNodeData(created.id, {
        src: result.url,
        alt: result.prompt,
        // 卡头很窄，标题留 12 个字就够认了（长了会溢出压住旁边的按钮）
        title: result.prompt.slice(0, 12),
        generatedBy: result.model,
        filePath: result.name,
        // 顺手把尺寸记上：节点渲染时也会从 <img> 补，但那要等一帧，
        // 这里直接给上，用户立刻能看到"1024×1024"、也能马上用扩图
        ...(wh ? { natural: { width: wh.w, height: wh.h } } : {}),
      });
      setGenerateState("idle", `已生成并落成节点：${result.model}`);
      setGenKind(null);
    },
    [addNodeAt, commitHistory, patchNodeData, rf, setGenerateState],
  );

  const markers = useRuntimeStore((s) => s.markers);
  const markerStyle = useRuntimeStore((s) => s.markerStyle);
  const useMarkersAsPrompt = useRuntimeStore((s) => s.useMarkersAsPrompt);
  const addMarker = useRuntimeStore((s) => s.addMarker);
  const undoMarker = useRuntimeStore((s) => s.undoMarker);
  const clearMarkers = useRuntimeStore((s) => s.clearMarkers);
  const setMarkerStyle = useRuntimeStore((s) => s.setMarkerStyle);
  const setUseMarkersAsPrompt = useRuntimeStore((s) => s.setUseMarkersAsPrompt);

  const markerDraw = useMarkerDraw({
    tool: markerTool,
    style: markerStyle,
    markers,
    toFlow: (event) => rf.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false }),
    onAdd: addMarker,
    // 画完回到选择模式；按住 Alt 则保持当前工具，便于连续标注
    onDrawn: (keepTool) => {
      if (!keepTool) setMarkerTool(null);
    },
  });

  /**
   * 标记模式与画布选择模式互斥。
   * 选择层用捕获阶段抢指针，不让位的话"切到标记工具后头几下画不出来"。
   */
  useEffect(() => {
    selection.setInert(markerTool !== null);
  }, [markerTool, selection]);
  /* ---------- 变更入口：全部经 store，撤销栈才拿得到一致快照 ---------- */

  /**
   * 导出 PNG（阶段 8.6，对标原版 `data-canvas-export-host/scene`）。
   *
   * 走主进程截屏，所以导出的是**屏幕分辨率** —— 屏幕上是压缩 77% 那导出就是 77% 的像素。
   * 想让导出更清晰，先把画布缩放调大再导（这一点写在界面提示里，不藏起来）。
   *
   * @param scope view = 整个可视画布区；frame = 选中/第一个画框
   */
  const onExport = useCallback(
    async (scope: "view" | "frame") => {
      const bridge = (window as unknown as { shell?: ShellBridge }).shell;
      if (!bridge?.canvas?.exportPng) {
        setGenerateState("idle", "导出需要 Electron 壳（浏览器里跑不了）");
        return;
      }

      let el: HTMLElement | null = null;
      let name = "画布";

      if (scope === "frame") {
        const frames = useRuntimeStore.getState().nodes.filter((n) => n.type === "frame");
        const picked = frames.find((n) => n.selected) ?? frames[0];
        if (!picked) {
          setGenerateState("idle", "还没有画框：先用「新建 → 画框」建一个");
          return;
        }
        el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${picked.id}"]`);
        name = (picked.data as { title?: string }).title ?? "画框";
      } else {
        // 整个画布区：用 .canvas-flow 而不是 .canvas-root，避免把工具条一起截进去
        el = document.querySelector<HTMLElement>(".canvas-flow");
      }

      if (!el) {
        setGenerateState("idle", "目标不在可视范围内，先点「适应视图」再导");
        return;
      }

      const rect = el.getBoundingClientRect();
      setGenerateState("idle", "正在导出…");

      /**
       * 导出前先把浮层藏起来（工具条 / 标记条 / 状态栏 / 提示 / 侧栏 / 缩略图）。
       *
       * 不藏的话导出的就是"一张带着工具栏的截图" —— 用户要的是**作品**，不是界面照。
       * 藏的是 `data-exporting` 这个属性，样式在 styles.css 里统一处理，
       * 比在这里逐个记类名可靠（以后加新浮层只要往那条规则里补一行）。
       *
       * 等两帧再截：第一帧提交隐藏，第二帧确保合成完成，否则会截到还没隐藏的旧画面。
       */
      setExporting(true);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      let result;
      try {
        result = await bridge.canvas.exportPng({
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          name,
        });
      } finally {
        setExporting(false);
      }

      if (result.ok) {
        setGenerateState("idle", `已导出 ${result.width}×${result.height} → exports/${result.file.split(/[\\/]/).pop()}`);
      } else {
        setGenerateState("idle", `导出失败：${result.error}`);
      }
    },
    [],
  );

  const onRevealExports = useCallback(() => {
    const bridge = (window as unknown as { shell?: ShellBridge }).shell;
    void bridge?.canvas?.revealExports?.();
  }, []);

  const onExportOrReveal = useCallback(
    (scope: "view" | "frame" | "reveal") => {
      if (scope === "reveal") onRevealExports();
      else void onExport(scope);
    },
    [onExport, onRevealExports],
  );

  const onNodesChange = useCallback(
    (changes: FlowChange[]) => {
      const dragging = changes.some((c) => c.type === "position" && c.dragging);
      const positional = changes.some((c) => c.type === "position");
      const structural = changes.some((c) => c.type === "remove" || c.type === "replace");
      if (dragging && !dragStartedRef.current) {
        dragStartedRef.current = true;
        commitHistory();
      }
      if (!positional) dragStartedRef.current = false;
      if (structural) commitHistory();
      applyNodeChanges(changes as NodeChange<CanvasNode>[]);

      /**
       * 拖完就重算画框归属（阶段 8.4）。
       * 要在这里做而不只在画框自己的 onPointerUp 里做：
       * 用户更常见的动作是**把卡片拖进画框**，那一次拖动结束时画框自己并没有被碰过。
       */
      const anyDragging = changes.some((c) => c.type === "position" && c.dragging);
      if (positional && !anyDragging) syncAllFrames();
    },
    [applyNodeChanges, commitHistory, syncAllFrames],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (changes.some((c) => c.type === "remove" || c.type === "replace")) commitHistory();
      applyEdgeChangesStore(changes);
    },
    [applyEdgeChangesStore, commitHistory],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      commitHistory();
      const state = useRuntimeStore.getState();
      const next: Edge[] = addEdge(connection, state.edges);
      useRuntimeStore.setState({ edges: next, revision: state.revision + 1 });
    },
    [commitHistory],
  );

  /* ---------- AI：选中素材 → 生成 → 落为新节点 ---------- */

  /**
   * 决定新节点落在哪里。
   *
   * 优先放在来源节点**右侧**（保持"左素材右产物"的阅读顺序）；
   * 但如果右侧会跑出当前视口，就退回到视口中心 —— 生成完看不见结果等于没生成。
   */
  const placeForGeneration = useCallback(
    (sources: CanvasNode[]): XYPosition => {
      const right = Math.max(...sources.map((n) => n.position.x + (n.width ?? 300)));
      const top = Math.min(...sources.map((n) => n.position.y));
      const candidate = { x: right + 60, y: top };

      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return candidate;
      /**
       * ⚠️ `screenToFlowPosition` 收的是**客户端坐标**（相对窗口），不是相对容器。
       * 早期版本这里传了 `0 / rect.width / rect.height`（容器相对），于是整个可见区域
       * 被算偏了一个侧栏的宽度和标题栏的高度 —— 表现是"新建的节点落在左侧栏底下，
       * 一拖就拖不动"。凡是把容器坐标喂给它，都必须先加上 `rect.left / rect.top`。
       */
      const topLeft = rf.screenToFlowPosition({ x: rect.left, y: rect.top });
      const bottomRight = rf.screenToFlowPosition({
        x: rect.left + rect.width,
        y: rect.top + rect.height,
      });
      const visible =
        candidate.x >= topLeft.x - 40 &&
        candidate.x + 340 <= bottomRight.x + 140 &&
        candidate.y >= topLeft.y - 40 &&
        candidate.y + 260 <= bottomRight.y + 140;
      if (visible) return candidate;

      const center = rf.screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
      return { x: center.x - 170, y: center.y - 130 };
    },
    [rf],
  );

  const onGenerate = useCallback(
    async (intent: GenerateIntent, instruction: string) => {
      const store = useRuntimeStore.getState();
      const sources = store.nodes.filter((n) => n.selected);
      if (sources.length === 0) {
        setGenerateState("idle", "先在画布上选中素材，再生成");
        return;
      }

      // 没有可用 provider 时不要静默失败，直接把原因摆到界面上
      const chat = useChatStore.getState();
      if (chat.providers.length === 0) await chat.loadProviders();
      const usable = useChatStore.getState().providers.some((p) => p.available);
      if (!usable) {
        setGenerateState(
          "idle",
          "没有可用的 AI provider（需要至少一个 provider 有密钥，且从 Electron 启动）",
        );
        return;
      }

      setGenerateState("generating");
      /**
       * 标记当提示词（阶段 5.3）：把标记覆盖到的节点与批注文字拼成一段要求。
       *
       * 这里从 **store 实时状态**读开关与标记，而不是用组件闭包里的值：
       * 生成是异步的，用户完全可能在生成前刚把开关点掉，闭包读到的是旧值。
       */
      const live = useRuntimeStore.getState();
      const withMarkers = instructionFromMarkers(live, live.useMarkersAsPrompt, instruction);
      const result = await generateNodeFromSelection(
        intent,
        withMarkers,
        placeForGeneration(sources),
        sources.map((n) => n.id),
      );
      setGenerateState("idle", result.error ?? null);
    },
    [setGenerateState],
  );

  /* ---------- 视图 ---------- */

  useOnViewportChange({ onEnd: (viewport) => setViewport(extractViewport(viewport)) });

  const onFitView = useCallback(() => {
    void rf.fitView({ padding: 0.2, duration: 200 });
  }, [rf]);

  /* ---------- 在视口中心创建节点 ---------- */

  const onAddNode = useCallback(
    (kind: NodeKind) => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      // 容器相对 → 客户端：必须先加上容器自身的偏移（见 placeForGeneration 里的说明）
      const center: XYPosition = {
        x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
        y: (rect?.top ?? 0) + (rect?.height ?? 0) / 2,
      };
      const at = rf.screenToFlowPosition(center);

      /**
       * 级联错位：连着新建几个时，别让它们**完全叠在同一个点上**。
       * 叠死的后果很实际 —— 上面那个把下面的整个盖住，用户点不到、也看不出来有几个。
       *
       * ⚠️ 这里有个坑：`addNodeAt` 把传入坐标当**中心**，会再按 `NODE_KIND_META[kind].size`
       * 折算出左上角。所以碰撞判断必须拿"**将成为**左上角的那个点"去比已有节点的
       * `position`（那才是左上角）；早期版本直接拿中心去比左上角，永远比不中，
       * 级联形同虚设（实测两个形状只差 8px，基本还是叠着）。
       */
      const meta = NODE_KIND_META[kind];
      const existing = useRuntimeStore.getState().nodes;
      const STEP = 48;
      const toTopLeft = (center: XYPosition) => ({
        x: center.x - meta.size.width / 2,
        y: center.y - meta.size.height / 2,
      });
      const collides = (center: XYPosition) => {
        const tl = toTopLeft(center);
        return existing.some(
          (n) => Math.abs(n.position.x - tl.x) < STEP / 2 && Math.abs(n.position.y - tl.y) < STEP / 2,
        );
      };
      let placedCenter = at;
      for (let i = 0; i < 40 && collides(placedCenter); i += 1) {
        placedCenter = { x: at.x + (i + 1) * STEP, y: at.y + (i + 1) * STEP };
      }

      commitHistory();
      addNodeAt(kind, placedCenter);
    },
    [addNodeAt, commitHistory, rf],
  );

  /** 快捷键：整张表声明在 `shortcuts.ts`，这里只做派发。 */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inEditor =
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement ||
        Boolean(target?.isContentEditable);

      const hit = matchShortcut({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        inEditor,
      });
      if (!hit) return;
      // 输入框里只放行全局语义的操作，其余交回浏览器做文本编辑
      if (inEditor && (hit === "toggleMarkers" || hit === "clearMarkers" || hit === "duplicate")) return;

      const store = useRuntimeStore.getState();
      switch (hit) {
        case "undo":
          event.preventDefault();
          undoHistory();
          return;
        case "redo":
          event.preventDefault();
          redoHistory();
          return;
        case "selectAll":
          event.preventDefault();
          selectNodes(store.nodes.map((n) => n.id));
          return;
        case "save":
          event.preventDefault();
          void saveNow();
          return;
        case "fitView":
          event.preventDefault();
          void rf.fitView({ padding: 0.2, duration: 200 });
          return;
        case "duplicate": {
          event.preventDefault();
          const created = store.duplicateSelected();
          if (created.length === 0) setGenerateState("idle", "先选中要复制的节点（Ctrl+D）");
          return;
        }
        case "copy": {
          event.preventDefault();
          const picked = store.nodes.filter((n) => n.selected);
          if (picked.length === 0) {
            setGenerateState("idle", "先选中要复制的节点（Ctrl+C）");
            return;
          }
          try {
            const text = serializeClipboard(picked, store.edges);
            void navigator.clipboard.writeText(text).then(
              () => setGenerateState("idle", null),
              () => setGenerateState("idle", "写入剪贴板失败（系统可能拒绝了权限）"),
            );
          } catch (error) {
            // 序列化不了就明确告诉用户，别静默什么都不做（对标原版那条提示）
            setGenerateState("idle", error instanceof Error ? error.message : "复制失败");
          }
          return;
        }
        case "cut": {
          event.preventDefault();
          const picked = store.nodes.filter((n) => n.selected);
          if (picked.length === 0) {
            setGenerateState("idle", "先选中要剪切的节点（Ctrl+X）");
            return;
          }
          try {
            const text = serializeClipboard(picked, store.edges);
            void navigator.clipboard.writeText(text);
            commitHistory();
            store.removeSelected();
          } catch (error) {
            setGenerateState("idle", error instanceof Error ? error.message : "剪切失败");
          }
          return;
        }
        case "paste": {
          event.preventDefault();
          void (async () => {
            let text = "";
            try {
              text = await navigator.clipboard.readText();
            } catch {
              setGenerateState("idle", "读剪贴板失败（系统可能拒绝了权限）");
              return;
            }
            const payload = parseClipboard(text);
            if (!payload) {
              setGenerateState("idle", "剪贴板里不是画布内容");
              return;
            }
            const rect = wrapperRef.current?.getBoundingClientRect();
            const at = rf.screenToFlowPosition({
              x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
              y: (rect?.top ?? 0) + (rect?.height ?? 0) / 2,
            });
            const plan = planPaste(payload, store.nodes, at);
            if (plan.nodes.length === 0) return;
            commitHistory();
            store.appendNodes(plan.nodes, plan.edges);
            setGenerateState("idle", null);
          })();
          return;
        }
        case "toggleMarkers":
          event.preventDefault();
          setMarkerTool((prev) => (prev === null ? "rect" : null));
          return;
        case "clearMarkers":
          event.preventDefault();
          store.clearMarkers();
          return;
        case "escape":
          // Esc 逐级退出：先收标记工具，再清标记选择，最后清节点选择
          setMarkerTool(null);
          store.selectMarker(null);
          selectNodes([]);
          return;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [redoHistory, rf, saveNow, selectNodes, setGenerateState, undoHistory]);

  const modeProps = selectionModeProps(mode);
  /** 标记模式下画布模式让位：不框选、不涂抹，但仍然可以平移看别处。 */
  const markerMode = markerTool !== null;

  return (
    <div
      ref={wrapperRef}
      className={`canvas-root nodrag${markerMode ? " is-marking" : ""}`}
      data-exporting={exporting ? "true" : undefined}
      data-canvas-keyboard-root
      data-selection-mode={mode}
      data-marker-tool={markerTool ?? "off"}
      {...selection.handlers}
      {...markerDraw.handlers}
    >
      <CanvasToolbar
        onAddNode={onAddNode}
        selectionCount={selectedCount}
        onGenerate={onGenerate}
        onFitView={onFitView}
        onReset={resetToSample}
        versionsOpen={versionsOpen}
        onToggleVersions={() => setVersionsOpen((prev) => !prev)}
        layersOpen={layersOpen}
        onToggleLayers={() => setLayersOpen((prev) => !prev)}
        onExport={onExportOrReveal}
      />

      <MarkerToolbar
        tool={markerTool}
        style={markerStyle}
        count={markers.length}
        useAsPrompt={useMarkersAsPrompt}
        onToolChange={setMarkerTool}
        onStyleChange={setMarkerStyle}
        onUndo={undoMarker}
        onClearAll={clearMarkers}
        onTogglePrompt={() => setUseMarkersAsPrompt(!useMarkersAsPrompt)}
      />

      {generateState === "generating" ? (
        <div className="canvas-toast is-busy">AI 生成中…</div>
      ) : generateError ? (
        <div
          className="canvas-toast is-error"
          title="点击关闭"
          onClick={() => setGenerateState("idle", null)}
        >
          {generateError}
        </div>
      ) : recoveryNote ? (
        <div
          className="canvas-toast is-recover"
          title="点击关闭"
          onClick={clearRecoveryNote}
        >
          {recoveryNote}
        </div>
      ) : null}

      <div className="canvas-flow">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeContextMenu={(event, node) => {
            /*
             * 在节点上右键 → 弹出节点菜单。用 React Flow 的 this hook 而不是给每个
             * 节点组件各加一个 onContextMenu：一处接上，六种节点都有。
             *
             * 必须 preventDefault：Electron 里不挡的话会弹出系统菜单，
             * 那会盖住我们自己的菜单（用户在画布上试右键是必然的事）。
             */
            event.preventDefault();
            setNodeMenu({ nodeId: node.id, x: event.clientX, y: event.clientY });
          }}
          nodeTypes={nodeTypes}
          defaultViewport={initialViewportRef.current}
          fitView
          minZoom={0.1}
          maxZoom={4}
          snapToGrid
          snapGrid={[16, 16]}
          deleteKeyCode={["Backspace", "Delete"]}
          multiSelectionKeyCode={["Control", "Meta", "Shift"]}
          selectionOnDrag={modeProps.selectionOnDrag}
          panOnDrag={modeProps.panOnDrag}
          elementsSelectable={modeProps.elementsSelectable}
          onlyRenderVisibleElements
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#242b38" />
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeColor="#3b82f6"
            maskColor="rgba(10,12,16,0.72)"
          />
          <SweepLayer
            sink={selection.setSink}
            mode={mode}
            showRubberBand={modeDrawsRubberBand(mode) && !markerMode}
            showTrail={modeDrawsTrail(mode) && !markerMode}
          />
          <MarkerLayer markers={markerDraw.draft ? [...markers, markerDraw.draft] : markers} />
        </ReactFlow>

        {markerDraw.editingMarker ? (
          <MarkerTextInput
            at={rf.flowToScreenPosition(markerDraw.editingMarker.from)}
            onSubmit={markerDraw.commitText}
            onCancel={markerDraw.cancelText}
          />
        ) : null}
      </div>

      {/* 底部工具条：对标原版 data-canvas-bottom-toolbar（选择/标记/图片生成/视频生成/撤销/缩放） */}
      <BottomToolbar
        mode={mode}
        onModeChange={setMode}
        markerMode={markerMode}
        onToggleMarkerMode={() => setMarkerTool((prev) => (prev === null ? "rect" : null))}
        markerCount={markers.length}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        onUndo={undoHistory}
        onRedo={redoHistory}
        genKind={genKind}
        onOpenGen={(kind) => setGenKind((prev) => (prev === kind ? null : kind))}
      />

      {/* 生成面板：图片 / 视频，生成结果落成节点 */}
      {genKind ? (
        <GeneratePanel kind={genKind} onDone={onGenDone} onClose={() => setGenKind(null)} />
      ) : null}

      <CanvasStatusBar
        nodeCount={nodes.length}
        edgeCount={edges.length}
        selectedCount={selectedCount}
        markerCount={markers.length}
        revision={revision}
        saveState={saveState}
      />

      <VersionHistoryPanel
        open={versionsOpen}
        currentRevision={revision}
        onClose={() => setVersionsOpen(false)}
      />

      <LayerPanel open={layersOpen} onClose={() => setLayersOpen(false)} />

      {/* 节点右键菜单（阶段 11.28）：动作集合与工具条/图层面板一致，不新增能力 */}
      {nodeMenu ? (
        <NodeContextMenu
          nodeId={nodeMenu.nodeId}
          x={nodeMenu.x}
          y={nodeMenu.y}
          onClose={() => setNodeMenu(null)}
        />
      ) : null}

      {/* 文字排版：只在恰好选中一个文字类节点时出现（对标 text-toolbar-popup） */}
      <TextToolbar />
    </div>
  );
}

/**
 * 把标记转成给模型的一段要求（阶段 5.3）。
 *
 * 只在开关打开、且确实有标记时才拼这一段；否则原样返回用户输入 ——
 * 不该因为"画布上有标记"就悄悄改变没打开这个功能的人看到的结果。
 *
 * @param store 当前画布状态
 * @param enabled 是否把标记当提示词
 * @param instruction 用户原本输入的要求
 * @returns 附加了标记描述的要求
 */
function instructionFromMarkers(
  store: Pick<RuntimeState, "markers" | "nodes">,
  enabled: boolean,
  instruction: string,
): string {
  if (!enabled || store.markers.length === 0) return instruction;
  const rects = new Map<string, Rect>();
  for (const node of store.nodes) {
    rects.set(node.id, {
      x: node.position.x,
      y: node.position.y,
      width: node.width ?? 300,
      height: node.height ?? 200,
    });
  }
  const marks = markersAsPrompt(store.markers, rects, (id) => {
    const node = store.nodes.find((n) => n.id === id);
    return node ? `${id}(${NODE_KIND_META[node.type as NodeKind]?.label ?? node.type})` : id;
  });
  if (!marks) return instruction;
  return `${instruction}\n\n【画布标记】\n${marks}`;
}
