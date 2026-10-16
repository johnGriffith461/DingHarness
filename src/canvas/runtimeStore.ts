import { create } from "zustand";
import { applyEdgeChanges, applyNodeChanges } from "@xyflow/react";
import type { Edge, EdgeChange, NodeChange, Viewport } from "@xyflow/react";
import type { CanvasNode, NodeKind } from "./types";
import { NODE_KIND_META, nextNodeId } from "./types";
import type { Marker, MarkerStyle } from "./markers";
import { DEFAULT_MARKER_COLOR, DEFAULT_MARKER_WIDTH } from "./markers";
import type { FlipAxis, LayerOrderOp } from "./layers";
import { applyOrder, flipState, reorderLayers } from "./layers";
import { planAdoption, toAbsolute } from "./frames";
import { supportsTextStyle, type TextStyle } from "./textStyle";

/**
 * 「正在连续调排版」标记（配合 `patchTextStyle`）。
 *
 * 拖一次滑块会连发几十个 change 事件；如果每次都记一条历史，
 * 用户按 Ctrl+Z 得按几十下才退得回去。所以第一次改动记一条，之后合并进同一条。
 * 放在模块级的定时器里清掉：停手 600ms 后再动就算新的一次调整。
 */
let textStyleHistoryOpen: ReturnType<typeof setTimeout> | null = null;
/** 供 store 内部读写的小盒子（避免把定时器塞进 state 里导致每次都触发订阅）。 */
const textStyleHistoryRef: { current: boolean } = { current: false };

function markTextStyleEditDone(): void {
  if (textStyleHistoryOpen) clearTimeout(textStyleHistoryOpen);
  textStyleHistoryOpen = setTimeout(() => {
    textStyleHistoryRef.current = false;
    textStyleHistoryOpen = null;
  }, 600);
}
import { createSampleGraph } from "./initialGraph";
import type { CanvasHistory, CanvasSnapshot } from "./history";
import {
  canRedo,
  canUndo,
  createHistoryState,
  pushHistory,
  redoHistory,
  undoHistory,
} from "./history";

/**
 * 画布运行时状态（自研 store，对标原版 `CanvasReactRuntimeProvider` 持有的那份画布状态）。
 *
 * 职责边界：
 *   · 节点 / 边 / 视口 / 修订号 / 撤销栈 —— 阶段 4 持久化要读的就是这几样
 *   · 阶段 2 之前不落盘，但"一份真相"的约束已经生效：所有变更都经由这里，
 *     撤销栈与后续的快照才拿得到一致结果
 *
 * 撤销栈放在 store 里而不是 hook 里，是因为节点渲染器（输入框、上传、换语言）
 * 散落在树深处，它们也要能打撤销点；统一走 store action 比层层传回调稳。
 */

export type RuntimeState = {
  nodes: CanvasNode[];
  edges: Edge[];
  viewport: Viewport;
  /** 单调递增修订号（对标原版 `documentRevision`）。阶段 4 接快照与 ack。 */
  revision: number;
  history: CanvasHistory;
  /** 标记层（阶段 5）：独立于节点的一层批注图形。 */
  markers: Marker[];
  /** 当前标记工具的样式。 */
  markerStyle: MarkerStyle;
  /** 生成时是否把标记当提示词（阶段 5.3）。 */
  useMarkersAsPrompt: boolean;

  applyNodeChanges: (changes: NodeChange<CanvasNode>[]) => void;
  applyEdgeChanges: (changes: EdgeChange[]) => void;
  setViewport: (viewport: Viewport) => void;

  /** 追加一个节点（id 由 `nextNodeId` 保证唯一）。 */
  addNode: (node: CanvasNode) => void;
  /** 在指定世界坐标创建一个指定类型的新节点。 */
  addNodeAt: (kind: NodeKind, at: { x: number; y: number }) => CanvasNode;
  /** 局部更新某个节点的 data（节点渲染器、生成状态、AI 生成都用它）。 */
  patchNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  /** 整体替换选中集（框选/涂抹选/全选用；React Flow 自带的 addSelectedNodes 是追加语义）。 */
  selectNodes: (ids: string[]) => void;

  /** 载入持久化文档（覆盖整块画布）。 */
  loadDocument: (input: {
    nodes: CanvasNode[];
    edges: Edge[];
    viewport: Viewport;
    revision: number;
    markers?: Marker[];
  }) => void;

  /* ---------- 标记层（阶段 5） ---------- */

  /** 追加一条标记。 */
  addMarker: (marker: Marker) => void;
  /** 删除标记。 */
  removeMarker: (id: string) => void;
  /** 清空标记（工具条"清空笔迹"）。 */
  clearMarkers: () => void;
  /** 选中某条标记（点中它时）。 */
  selectMarker: (id: string | null) => void;
  /** 撤销最后一条标记（涂鸦工具条"撤销上一笔"）。 */
  undoMarker: () => void;
  /** 生成时是否把标记当提示词。 */
  setUseMarkersAsPrompt: (next: boolean) => void;
  /** 当前标记工具的样式（颜色/粗细）。 */
  setMarkerStyle: (style: MarkerStyle) => void;

  /**
   * 原地复制选中的节点（连带它们之间的连线）。
   * @param offset 复制体的位移，避免和原件完全重叠
   * @returns 新节点 id
   */
  duplicateSelected: (offset?: number) => string[];

  /**
   * 追加一批节点与连线（粘贴用），并只选中新来的那批。
   * @returns 新节点 id
   */
  appendNodes: (nodes: CanvasNode[], edges: Edge[]) => string[];

  /** 删除选中的节点（连带挂在它们上面的连线）。 */
  removeSelected: () => void;

  /**
   * 把"父节点即将消失"的子节点救回顶层（清 `parentId` 并换成绝对坐标）。
   *
   * ⚠️ 2026-10-16 审计 P106：React Flow 自带的删除（Delete/Backspace）会把
   * `parentId` 命中被删节点的**子节点一起收进删除集**，与 `removeSelected` 里
   * 明示的取舍（"删画框不该带走框里的卡片"）正好相反。那条路走的是
   * `onNodesDelete` → 这里，于是两条删除路径共用同一处实现。
   *
   * 不这么做的后果是：卡片还留在数组里但 `parentId` 指向一个不存在的节点，
   * React Flow 会警告 `Parent node ... not found` 并把它按相对坐标乱放。
   *
   * @param doomedIds 即将被删掉的节点 id
   */
  adoptOrphans: (doomedIds: Iterable<string>) => void;

  /* ---------- 图层（阶段 8.1 / 8.2） ---------- */

  /** 调整某一层的顺序（置顶/上移/下移/置底）。 */
  reorderLayer: (id: string, op: LayerOrderOp) => void;
  /** 显示 / 隐藏某一层。 */
  setLayerHidden: (id: string, hidden: boolean) => void;
  /** 锁定 / 解锁某一层（锁定后拖不动，但仍可选中查看）。 */
  setLayerLocked: (id: string, locked: boolean) => void;
  /** 水平 / 垂直翻转某一层。 */
  flipLayer: (id: string, axis: FlipAxis) => void;

  /**
   * 改选中节点的文字排版（阶段 8.5）。
   *
   * 作用于**当前所有选中**的节点：只选中一个时就是改它，
   * 多选时一次统一成同一套排版 —— 这比"每个节点单独调一遍"省事得多。
   * 改之前会先记一次历史，所以 Ctrl+Z 能整体撤回来。
   */
  patchTextStyle: (patch: TextStyle) => void;

  /**
   * 重新计算画框的归属（阶段 8.4，对标 `moveFrameWithChildren`）。
   *
   * 在画框**拖动结束**时调用：把中心落在框内的节点收成子节点、
   * 把已被拖出框的节点放回顶层。收/放的时候连带把 `position` 在
   * 绝对坐标 ↔ 相对坐标之间换算（React Flow 的子节点存的是相对父节点的位移）。
   */
  syncFrameMembership: (frameId: string) => void;

  /**
   * 对所有画框重算一遍归属。
   * 拖完任意节点、或新建节点之后调用 —— 这样"把卡片拖进画框"也能立刻生效，
   * 而不必先把画框本身拖一下。
   */
  syncAllFrames: () => void;

  /** 打一个撤销点（当前整图入栈）。 */
  commitHistory: () => void;
  undoHistory: () => void;
  redoHistory: () => void;

  /** AI 生成状态（工具条据此显示"生成中"与失败原因）。 */
  generateState: "idle" | "generating";
  generateError: string | null;
  setGenerateState: (state: "idle" | "generating", error?: string | null) => void;

  /** 重建示例画布。 */
  resetToSample: () => void;
};

const sample = createSampleGraph();

/** 从 store 状态取当前整图快照。 */
function snapshotOf(state: Pick<RuntimeState, "nodes" | "edges">): CanvasSnapshot {
  return { nodes: state.nodes, edges: state.edges };
}

/**
 * 把父节点（画框）排到子节点前面。
 *
 * React Flow 的硬性要求：**父节点必须出现在子节点之前**，否则它解析父子关系时会
 * 直接报错（"Parent node not found"）并把子节点渲染成孤立节点。
 * 每次改变归属之后都过一遍，比在每个改动点各记一次要可靠。
 */
function orderParentsFirst(nodes: CanvasNode[]): CanvasNode[] {
  const parents = nodes.filter((n) => n.type === "frame");
  if (parents.length === 0) return nodes;
  const parentIds = new Set(parents.map((n) => n.id));
  const rest = nodes.filter((n) => !parentIds.has(n.id));
  return [...parents, ...rest];
}

/**
 * 把"父节点在被删之列"的子节点救回顶层（清 `parentId`、位置换成绝对坐标）。
 *
 * 必须在**真的把父节点从数组里去掉之前**算：`toAbsolute` 要顺着父链取偏移，
 * 父已经不在表里就只能拿到子节点那份相对坐标（那正是画布上"卡片突然跑到左上角"的来源）。
 *
 * @param nodes 当前节点（含即将被删的那些）
 * @param doomed 即将被删的节点 id
 * @returns 救过的节点数组；一个都不用救时**返回原数组**（免得白造一份引用）
 */
function rescueOrphansOf(nodes: CanvasNode[], doomed: ReadonlySet<string>): CanvasNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let changed = false;
  const out = nodes.map((n) => {
    if (!n.parentId || !doomed.has(n.parentId)) return n;
    changed = true;
    return { ...n, parentId: undefined, position: toAbsolute(n, byId) } as CanvasNode;
  });
  return changed ? out : nodes;
}

export const useRuntimeStore = create<RuntimeState>()((set, get) => ({
  nodes: sample.nodes,
  edges: sample.edges,
  viewport: { x: 0, y: 0, zoom: 1 },
  revision: 0,
  history: createHistoryState(),
  markers: [],
  markerStyle: { color: DEFAULT_MARKER_COLOR, width: DEFAULT_MARKER_WIDTH },
  useMarkersAsPrompt: true,
  generateState: "idle",
  generateError: null,

  setGenerateState: (generateState, error = null) => set({ generateState, generateError: error }),

  addMarker: (marker) =>
    set((state) => ({
      markers: [...state.markers.map((m) => (m.selected ? { ...m, selected: false } : m)), marker],
      revision: state.revision + 1,
    })),

  removeMarker: (id) =>
    set((state) => ({
      markers: state.markers.filter((m) => m.id !== id),
      revision: state.revision + 1,
    })),

  clearMarkers: () => set((state) => ({ markers: [], revision: state.revision + 1 })),

  selectMarker: (id) =>
    set((state) => ({
      markers: state.markers.map((m) => (m.selected === (m.id === id) ? m : { ...m, selected: m.id === id })),
    })),

  undoMarker: () =>
    set((state) => ({
      markers: state.markers.slice(0, -1),
      revision: state.revision + 1,
    })),

  setUseMarkersAsPrompt: (useMarkersAsPrompt) => set({ useMarkersAsPrompt }),

  setMarkerStyle: (markerStyle) => set({ markerStyle }),

  duplicateSelected: (offset = 28) => {
    const state = get();
    const sources = state.nodes.filter((n) => n.selected);
    if (sources.length === 0) return [];

    // 逐个分配新 id（对着不断增长的列表算，避免复制体之间撞 id）
    const idMap = new Map<string, string>();
    let pool = state.nodes;
    for (const source of sources) {
      const id = nextNodeId(pool);
      idMap.set(source.id, id);
      pool = [...pool, { ...source, id }];
    }

    /**
     * 复制体沿用原节点的类型与内容，只换 id 与位置。
     *
     * 这里必须 `as CanvasNode`：`CanvasNode` 是六种节点类型的联合，
     * 而展开一个联合类型得到的是"跨类型的对象"——TypeScript 无法在保持
     * `type` 与 `data` 对应关系的前提下证明它属于某一种成员。
     * 运行期是安全的：`type` 与 `data` 都是从同一个原节点整体拷过来的，没有交叉。
     */
    const copies = sources.map(
      (source) =>
        ({
          ...source,
          id: idMap.get(source.id) as string,
          /*
           * ⚠️ `parentId` 要**跟着 id 映射走**（2026-10-16 审计 P24）：
           * 复制"画框 + 框里的卡片"时，原来复制体的 `parentId` 原样指着**原来那个画框**——
           * 于是复制出来的卡片挂回原框（新框是空的），而它按"相对原框"的坐标摆，
           * 视觉上是"复制了一份画框，卡片却没跟着进新框"。
           *
           * 父**不在**复制集里时保留原父：那是"在同一个画框里原地复制一张卡片"，语义正确
           * （`position` 本来就是相对同一个父的，偏移量直接加就对）。
           */
          parentId: source.parentId && idMap.has(source.parentId) ? idMap.get(source.parentId) : source.parentId,
          position: { x: source.position.x + offset, y: source.position.y + offset },
          selected: true,
          data: JSON.parse(JSON.stringify(source.data ?? {})) as CanvasNode["data"],
        }) as CanvasNode,
    );

    // 只复制"两端都在复制范围内"的连线，跨范围的连线留原样（避免语义被改）
    const innerEdges = state.edges
      .filter((edge) => idMap.has(edge.source) && idMap.has(edge.target))
      .map((edge, index) => ({
        ...edge,
        id: `${edge.id}-copy-${index + 1}`,
        source: idMap.get(edge.source) as string,
        target: idMap.get(edge.target) as string,
        selected: false,
      }));

    set({
      /*
       * ⚠️ 过一遍 `orderParentsFirst`（2026-10-16 审计 P24）：
       * 复制出来的画框可能被追加在它的卡片后面（源数组里卡片在前时就是这样），
       * 而 React Flow **要求父节点排在子节点之前**，否则会报
       * `Parent node ... not found` 并把子节点按孤立节点渲染。
       */
      nodes: orderParentsFirst([...state.nodes.map((n) => ({ ...n, selected: false })), ...copies]),
      edges: [...state.edges, ...innerEdges],
      revision: state.revision + 1,
    });
    return copies.map((c) => c.id);
  },

  applyNodeChanges: (changes) => {
    // 纯选择态 / 尺寸测量变化不改画布内容，不应该推高修订号
    const structural = changes.some((c) => c.type !== "select" && c.type !== "dimensions");
    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes),
      revision: structural ? state.revision + 1 : state.revision,
    }));
  },

  applyEdgeChanges: (changes) => {
    const structural = changes.some((c) => c.type !== "select");
    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges),
      revision: structural ? state.revision + 1 : state.revision,
    }));
  },

  /**
   * 写回视口（React Flow 在 `onViewportChange(end)` 时调，见 `CanvasRuntime`）。
   *
   * ⚠️ **故意不推修订号**（2026-10-16 审计 P30）：修订号是**内容**的版本，平移/缩放没有改内容。
   * 但这么一来"视口变了"就不能再靠修订号被持久化侧看见 —— 所以判定移到了
   * `canvasSaver.isPersistableChange`（它同时看修订号与视口的三个数）。
   * 谁要再加一条"只比 revision"的订阅，就会把视口永久地挡在存档之外。
   */
  setViewport: (viewport) => set({ viewport }),

  addNode: (node) =>
    set((state) => ({ nodes: [...state.nodes, node], revision: state.revision + 1 })),

  addNodeAt: (kind, at) => {
    const meta = NODE_KIND_META[kind];
    const state = get();
    const node = meta.create(nextNodeId(state.nodes), {
      x: at.x - meta.size.width / 2,
      y: at.y - meta.size.height / 2,
    });
    set({
      nodes: [...state.nodes, { ...node, ...meta.size }],
      revision: state.revision + 1,
    });
    return node;
  },

  patchNodeData: (nodeId, patch) =>
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId
          ? ({ ...node, data: { ...node.data, ...patch } } as CanvasNode)
          : node,
      ),
      revision: state.revision + 1,
    })),

  selectNodes: (ids) => {
    const wanted = new Set(ids);
    set((state) => ({
      nodes: state.nodes.map((node) =>
        Boolean(node.selected) === wanted.has(node.id) ? node : { ...node, selected: wanted.has(node.id) },
      ),
    }));
  },

  loadDocument: ({ nodes, edges, viewport, revision, markers }) =>
    set({
      nodes: nodes.map((node) => ({ ...node, selected: false })),
      edges,
      viewport,
      revision,
      markers: markers ?? [],
      // 载入的是磁盘上的状态，历史栈从空开始（撤销不该跨会话回退到上一次运行）
      history: createHistoryState(),
    }),

  appendNodes: (nodes, edges) => {
    if (nodes.length === 0) return [];
    const created = nodes.map((n) => n.id);
    set((state) => ({
      // 只选中新粘贴进来的，旧的选择清掉（用户接下来多半要拖这一批）
      nodes: [...state.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), ...nodes],
      edges: [...state.edges, ...edges],
      revision: state.revision + 1,
    }));
    return created;
  },

  removeSelected: () => {
    const state = get();
    const doomed = new Set(state.nodes.filter((n) => n.selected).map((n) => n.id));
    if (doomed.size === 0) return;

    /**
     * 删掉一个画框时，它框住的节点不能跟着消失 —— 那些是用户的内容，
     * 只是"曾经放在这一屏里"。把它们的坐标从相对换回绝对，然后放回顶层。
     * 不这么做的后果是：节点还留在数组里但 `parentId` 指向一个不存在的节点，
     * React Flow 会直接不渲染它们（画布上凭空少东西，用户以为被删了）。
     *
     * ⚠️ 2026-10-16 审计 P106：这段与 React Flow 自带删除那条路（`adoptOrphans`）
     * 共用**同一处实现** —— 两条删除路径的取舍必须一致，否则"按 Delete 删画框"
     * 与"右键删除画框"会给出两种结果。
     */
    set({
      nodes: rescueOrphansOf(state.nodes, doomed).filter((n) => !doomed.has(n.id)),
      // 两端有一端没了，这条线也留不住
      edges: state.edges.filter((e) => !doomed.has(e.source) && !doomed.has(e.target)),
      revision: state.revision + 1,
    });
  },

  adoptOrphans: (doomedIds) => {
    const doomed = new Set(doomedIds);
    if (doomed.size === 0) return;
    set((state) => {
      const nodes = rescueOrphansOf(state.nodes, doomed);
      if (nodes === state.nodes) return {};
      return { nodes, revision: state.revision + 1 };
    });
  },

  reorderLayer: (id, op) =>
    set((state) => {
      const order = reorderLayers(
        state.nodes.map((n) => n.id),
        id,
        op,
      );
      const nodes = applyOrder(state.nodes, order);
      // 顺序没变就不推修订号（点"已经在顶"的置顶不该产生一次存档）
      if (nodes === state.nodes) return {};
      return { nodes, revision: state.revision + 1 };
    }),

  setLayerHidden: (id, hidden) =>
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? ({ ...n, hidden } as CanvasNode) : n)),
      revision: state.revision + 1,
    })),

  setLayerLocked: (id, locked) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id
          ? ({
              ...n,
              // 锁定时顺手关掉可拖动：React Flow 原生认这个字段，
              // 只标 data.locked 的话用户还是能把它拖走（等于锁了个寂寞）
              draggable: !locked,
              data: { ...n.data, locked },
            } as unknown as CanvasNode)
          : n,
      ),
      revision: state.revision + 1,
    })),

  flipLayer: (id, axis) =>
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== id) return n;
        const data = n.data as Record<string, unknown>;
        const next = flipState({ flipX: Boolean(data.flipX), flipY: Boolean(data.flipY) }, axis);
        return { ...n, data: { ...data, ...next } } as unknown as CanvasNode;
      }),
      revision: state.revision + 1,
    })),

  patchTextStyle: (patch) => {
    const state = get();
    const targets = state.nodes.filter((n) => n.selected && supportsTextStyle(n.type));
    if (targets.length === 0) return;
    // 拖滑块会连发很多次：只在**第一次**改动前记历史，否则撤销要按几十下才退回去
    if (!textStyleHistoryRef.current) {
      textStyleHistoryRef.current = true;
      get().commitHistory();
    }
    const targetIds = new Set(targets.map((t) => t.id));
    set({
      nodes: state.nodes.map((n) => {
        if (!targetIds.has(n.id)) return n;
        const data = n.data as Record<string, unknown>;
        return {
          ...n,
          data: {
            ...data,
            textStyle: { ...((data.textStyle as TextStyle | undefined) ?? {}), ...patch },
          },
        } as unknown as CanvasNode;
      }),
      revision: state.revision + 1,
    });
    markTextStyleEditDone();
  },

  syncFrameMembership: (frameId) =>
    set((state) => {
      const plan = planAdoption(state.nodes, frameId);
      if (plan.adopt.length === 0 && plan.release.length === 0) return {};
      const frame = state.nodes.find((n) => n.id === frameId);
      if (!frame) return {};

      /**
       * ⚠️⚠️ **换算必须走绝对坐标**（2026-10-16 审计 P248）。
       *
       * 原来这四处都是拿 `n.position` 直接加减 `frame.position` —— 而 `n.position`
       * 对**子节点**来说是**相对它自己那个父节点**的（React Flow 的约定）。
       * 于是"把一张卡片从画框 B 拖进画框 A"这条最常见的动作会**瞬移**：
       * 卡片这一刻还挂在 B 上（`planAdoption` 判的是绝对位置，所以它确实算"该进 A"），
       * 而写回时按"相对 B 的坐标 − A 的坐标"算，漏掉了 B 的偏移 ——
       * 松手瞬间卡片飞出去，用户以为画布坏了。
       *
       * `toAbsolute` 正是为此而写（它会沿父链累加）。换算一律走它：
       *   · 收成 A 的子节点 → 绝对位置 − A 的绝对位置
       *   · 放回顶层 → 就是绝对位置
       */
      const byId = new Map(state.nodes.map((n) => [n.id, n]));
      const frameAbs = toAbsolute(frame, byId);
      const adoptSet = new Set(plan.adopt);
      const releaseSet = new Set(plan.release);
      const nodes = state.nodes.map((n) => {
        if (adoptSet.has(n.id)) {
          // 变成子节点：存相对**画框**的位移（不管这一步之前挂在谁下面）
          const abs = toAbsolute(n, byId);
          return {
            ...n,
            parentId: frameId,
            position: { x: abs.x - frameAbs.x, y: abs.y - frameAbs.y },
          } as CanvasNode;
        }
        if (releaseSet.has(n.id)) {
          // 回到顶层：换成绝对坐标
          return {
            ...n,
            parentId: undefined,
            position: toAbsolute(n, byId),
          } as CanvasNode;
        }
        return n;
      });

      return {
        nodes: orderParentsFirst(nodes),
        revision: state.revision + 1,
      };
    }),

  syncAllFrames: () => {
    const frames = get().nodes.filter((n) => n.type === "frame");
    // 一个个来：两次 sync 之间数组会变，一次算完再算下一个才不会互相踩
    for (const frame of frames) get().syncFrameMembership(frame.id);
  },

  commitHistory: () =>
    set((state) => ({ history: pushHistory(state.history, snapshotOf(state)) })),

  undoHistory: () =>
    set((state) => {
      const result = undoHistory(state.history);
      if (!result.apply) return {};
      return {
        nodes: result.apply.nodes as unknown as CanvasNode[],
        edges: result.apply.edges,
        history: { past: result.state.past, future: [...result.state.future, snapshotOf(state)] },
        revision: state.revision + 1,
      };
    }),

  redoHistory: () =>
    set((state) => {
      const result = redoHistory(state.history, snapshotOf(state));
      if (!result.apply) return {};
      return {
        nodes: result.apply.nodes as unknown as CanvasNode[],
        edges: result.apply.edges,
        history: result.state,
        revision: state.revision + 1,
      };
    }),

  resetToSample: () => {
    const graph = createSampleGraph();
    set((state) => ({
      nodes: graph.nodes,
      edges: graph.edges,
      markers: [],
      revision: state.revision + 1,
    }));
  },
}));

/** 撤销 / 重做是否可用（选择器里直接用，避免工具条订阅整个 store）。 */
export function selectCanUndo(state: RuntimeState): boolean {
  return canUndo(state.history);
}

export function selectCanRedo(state: RuntimeState): boolean {
  return canRedo(state.history);
}

/** 从 store 之外取整图快照（阶段 4 写快照时复用）。 */
export function currentSnapshot(): CanvasSnapshot {
  const { nodes, edges } = useRuntimeStore.getState();
  return { nodes, edges };
}

// 开发模式下把 store 挂到 window，便于在浏览器控制台/自动化脚本里直接核对画布状态。
// 注意要判 `typeof window`：单测跑在 node 环境里，没有 window。
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__canvasStore = useRuntimeStore;
}
