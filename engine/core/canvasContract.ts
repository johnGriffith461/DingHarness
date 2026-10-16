import type { CanvasDocument, CanvasViewport } from "../../shared/canvas";
import type { Actor } from "./actor";

/**
 * **画布语义契约**（C6，V5-1 任务 3.9）。
 *
 * ## 它解决什么
 *
 * 画布在事件流**之外**：它是 `CanvasDocument`（一个 JSON 快照，带 revision 计数），
 * 于是"谁在什么时候加了哪个节点、连了哪条边"在会话日志里**查不到** ——
 * 而协作（V5-3 的共享与接管）与审计（C5）都要这两件事。
 *
 * 这一层把画布操作**定义成事件**（可与会话日志同构地存储与回放），
 * 并给出与现有 `CanvasDocument` 的**双向桥**（存量只读旧写新，见 §3.9d）。
 *
 * ## 与 V6 的边界（别越界）
 *
 * 这里**只冻语义**：事件类型、折叠规则、归属、工具族的权限映射。
 * 画布引擎的选型与产品重生（tldraw 混合路线 / JSON Canvas 兼容）是 V6 的事
 * （V5 §10）—— 所以本轮**不换**现有画布的存储与渲染，只把"事件化"这条路铺好、
 * 并把存量文档的转换等价性证明出来（转换后重放 diff=0）。
 *
 * ## 纯逻辑
 *
 * 不 import fs/electron/node:*（内核边界守卫盯着 `engine/core/**`）。
 */

/**
 * 画布事件的类型。
 *
 * ⚠️ V5 §3.9 写「七类」但列了**八个**名字（open / node.create / node.update / node.delete /
 * edge.create / edge.delete / marker.add / fork）。实现取**列出的名字**为准，
 * 不以计数为准（ADR-009 记了这处差异）。`viewport` 在方案里说"各为一事件"、
 * 却没有给类型名 —— 它并进 `canvas.open` 的载荷（那时它是"这张画布长什么样"的一部分）；
 * 将来真要一条独立的"视口变了"事件，那是一次契约变更（带 ADR），不在这里顺手加。
 */
export const CANVAS_EVENT_TYPES = [
  "canvas.open",
  "node.create",
  "node.update",
  "node.delete",
  "edge.create",
  "edge.delete",
  "marker.add",
  "fork",
] as const;
export type CanvasEventType = (typeof CANVAS_EVENT_TYPES)[number];

/** 一条画布事件（进事件存储的形状与它同构：seq 单调、at 时刻、actor 有就有）。 */
export type CanvasEvent = {
  type: CanvasEventType;
  /** 哪个画布（**归属在画布上**，节点随画布 —— 3.9b；节点自己不背 owner）。 */
  canvasId: string;
  /** 这张画布的事件流里单调递增（从 1 开始；`revision` 就从它平移过来）。 */
  seq: number;
  /** 发生时刻（epoch ms）。 */
  at: number;
  /** 谁干的（C5 的 actor；缺省读回 `legacy`，与日志同一条纪律）。 */
  actor?: Actor;
  /** `canvas.open`：这张画布归谁 + 初始视口（"长什么样"的一部分）。 */
  owner?: string;
  viewport?: CanvasViewport;
  /** 节点/边/标记的载荷（结构与 `CanvasDocument` 里那些元素同形，原样进出）。 */
  node?: unknown;
  edge?: unknown;
  marker?: unknown;
  /** `node.update` / 删除类：改哪个（`patch` 是要合并的字段）。 */
  id?: string;
  patch?: Record<string, unknown>;
  /** `fork`：从哪张画布的哪个修订分出来。 */
  source?: { canvasId: string; revision: number };
};

/** 折叠出来的画布状态（= `CanvasDocument` 的内容部分 + 归属）。 */
export type CanvasState = {
  canvasId: string;
  /** 归属（从 `canvas.open` 拿；缺省 `local` —— 兼容矩阵口径）。 */
  owner: string;
  /** **revision 平移为事件序号**（3.9d）：最后一个 `seq` 就是它。 */
  revision: number;
  /**
   * 确认位点（对标原版 ack）：**多少号之前的事件已经确认落盘**。
   * 由调用方给（`foldCanvas(events, { confirmedRevision })`）—— "确认"是宿主的动作，
   * 不是事件能自证的（同 `CanvasDocument.confirmedRevision` 的语义）。
   */
  confirmedRevision: number;
  viewport: CanvasViewport;
  nodes: unknown[];
  edges: unknown[];
  markers: unknown[];
};

/** 缺省视口（与 `shared/canvas.ts` 的初始文档一致）。 */
export const DEFAULT_CANVAS_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

/** 本机用户那个 id（与 C1/C4/C5 同一个 id 空间；三处各写一份的理由见 ADR-007 的说明）。 */
export const DEFAULT_CANVAS_OWNER = "local";

/** 折叠选项。 */
export type FoldCanvasOptions = {
  /** 确认位点（省略 = `revision`，即"全部已确认"—— 存量转换出来的就是已落盘的内容）。 */
  confirmedRevision?: number;
};

/** 把节点合并进数组（按 id 就地替换；不在就追加）。 */
function withPatch(list: unknown[], id: string, patch: Record<string, unknown>): unknown[] {
  const idx = list.findIndex((x) => (x as { id?: unknown } | null)?.id === id);
  if (idx < 0) return list; // 找不到就什么都不做（事件流被截过：不凭空造一个节点）
  const merged = { ...(list[idx] as Record<string, unknown>), ...patch };
  return list.map((x, i) => (i === idx ? merged : x));
}

/**
 * **状态 = fold(events)**（与内核主循环同一条不变量）。
 *
 * 纯函数；`seq` 乱序/重复都不怕（按 seq 排序、同号后者覆盖 —— 与存储的追加语义一致）。
 *
 * @param events 这张画布的事件（可以不排序）
 * @param opts 见 `FoldCanvasOptions`
 * @returns 折叠出的状态
 */
export function foldCanvas(events: readonly CanvasEvent[], opts: FoldCanvasOptions = {}): CanvasState {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const state: CanvasState = {
    canvasId: ordered[0]?.canvasId ?? "",
    owner: DEFAULT_CANVAS_OWNER,
    revision: 0,
    confirmedRevision: 0,
    viewport: { ...DEFAULT_CANVAS_VIEWPORT },
    nodes: [],
    edges: [],
    markers: [],
  };

  for (const event of ordered) {
    state.canvasId = event.canvasId;
    state.revision = Math.max(state.revision, event.seq);
    switch (event.type) {
      case "canvas.open":
        if (event.owner?.trim()) state.owner = event.owner.trim();
        if (event.viewport) state.viewport = { ...event.viewport };
        break;
      case "node.create":
        if (event.node !== undefined) state.nodes = [...state.nodes, event.node];
        break;
      case "node.update":
        if (event.id && event.patch) state.nodes = withPatch(state.nodes, event.id, event.patch);
        break;
      case "node.delete":
        if (event.id) state.nodes = state.nodes.filter((x) => (x as { id?: unknown } | null)?.id !== event.id);
        break;
      case "edge.create":
        if (event.edge !== undefined) state.edges = [...state.edges, event.edge];
        break;
      case "edge.delete":
        if (event.id) state.edges = state.edges.filter((x) => (x as { id?: unknown } | null)?.id !== event.id);
        break;
      case "marker.add":
        if (event.marker !== undefined) state.markers = [...state.markers, event.marker];
        break;
      case "fork":
        /* fork 是**新的一张画布**的起点：在它自己的流里它只是"我从哪来"的记录。
           真正的复制（把源画布的状态搬过来）由 fork 的那一侧写好 —— 见 ADR-009。 */
        break;
    }
  }

  state.confirmedRevision = Math.max(0, Math.min(opts.confirmedRevision ?? state.revision, state.revision));
  return state;
}

/**
 * **存量桥接**（3.9d）：`CanvasDocument` → 事件序列（**只读旧、写新**：不改编现有文档）。
 *
 * 规则（V5 §3.9d 的原文，落实到这份文档结构上）：
 *   · `nodes[]` / `edges[]` / `markers[]` 的每个元素**按顺序**展开成事件
 *     （`node.create` / `edge.create` / `marker.add`）；
 *   · **viewport 一条事件**：并进 `canvas.open` 的载荷（那时它就是"这张画布长什么样"）；
 *   · `revision` / `confirmedRevision` 平移为**事件序号 + 确认位点**（转换出来的序列
 *     `seq = 1..N`，`confirmedRevision = N` —— 存量内容是已落盘的，这一点不丢）。
 *
 * ⚠️ **方案说"按创建时间戳排序"，而这份文档里没有这个字段**（React Flow 的 Node
 * 不带 `createdAt`，边/标记也没有）。所以按**数组顺序**展开 —— 那是它事实上的创建顺序
 * （节点是追加进数组的）。这处差异记在 ADR-009：将来真给元素补上时间戳，
 * 排序规则要跟着换成"按时间戳、同刻按数组序"（那是一次契约变更）。
 *
 * @param doc 现有画布文档（不可信来源要自己先过 `migrateCanvasDoc`）
 * @param opts.owner 这张画布归谁（缺省 `local`）
 * @param opts.at 事件时刻（缺省 0：**存量转换不编时间**——它不是"现在发生的"）
 * @param opts.actor 谁干的（通常不填：存量数据里没有这个事实）
 * @returns 事件序列（`seq` 从 1 连续）
 */
export function canvasDocToEvents(
  doc: Pick<CanvasDocument, "nodes" | "edges" | "markers" | "viewport">,
  opts: { owner?: string; at?: number; actor?: Actor; canvasId?: string } = {},
): CanvasEvent[] {
  const canvasId = opts.canvasId ?? "";
  const at = opts.at ?? 0;
  let seq = 0;
  const next = (): number => (seq += 1);
  const base = { canvasId, at, ...(opts.actor ? { actor: opts.actor } : {}) };

  const events: CanvasEvent[] = [
    {
      ...base,
      type: "canvas.open",
      seq: next(),
      owner: opts.owner?.trim() || DEFAULT_CANVAS_OWNER,
      viewport: { ...(doc.viewport ?? DEFAULT_CANVAS_VIEWPORT) },
    },
  ];
  for (const node of doc.nodes ?? []) events.push({ ...base, type: "node.create", seq: next(), node });
  for (const edge of doc.edges ?? []) events.push({ ...base, type: "edge.create", seq: next(), edge });
  for (const marker of doc.markers ?? []) events.push({ ...base, type: "marker.add", seq: next(), marker });
  return events;
}

/**
 * 事件序列 → `CanvasDocument`（折叠 + 补上文档自己的那几格）。
 *
 * @param events 这张画布的事件
 * @param opts 文档的版本与时间（`version` 由宿主给：它知道当前格式是第几版）
 * @returns 与 `CanvasDocument` 同形的文档
 */
export function canvasEventsToDoc(
  events: readonly CanvasEvent[],
  opts: { version: number; updatedAt?: string; confirmedRevision?: number },
): CanvasDocument {
  const state = foldCanvas(events, { ...(opts.confirmedRevision === undefined ? {} : { confirmedRevision: opts.confirmedRevision }) });
  return {
    version: opts.version,
    revision: state.revision,
    confirmedRevision: state.confirmedRevision,
    ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
    viewport: state.viewport,
    nodes: state.nodes,
    edges: state.edges,
    markers: state.markers,
  };
}

/**
 * 这张画布**归谁**（3.9b：归属在画布上，节点随画布 —— 节点自己不背 owner）。
 *
 * @param events 这张画布的事件
 * @returns owner（`canvas.open` 里那一格；缺省 `local`）
 */
export function canvasOwner(events: readonly CanvasEvent[]): string {
  return foldCanvas(events).owner;
}

/* ============================================================
 * 工具族边界（3.9c）：declared surface + 权限映射
 * ============================================================ */

/**
 * 画布工具族的 **declared surface**（V5 §3.9c 的五个动作）与它们**在工具轴上的判定**。
 *
 * 为什么要有这张表：`canvas_add_node` 现在是孤零零一个工具（策略表里一条 `write`）；
 * 画布工具族一多，就会出现"某个画布工具忘了声明 → 掉进默认只读 → 在按需确认档下
 * 直接放行"。这张表把**这类工具该有的判定**先定下来（与审计 P02 的插件/MCP 教训同一形状：
 * 对"会改东西"的一族，默认必须收口）。
 *
 * | surface | 干什么 | 工具轴 |
 * |---|---|---|
 * | `read` | 看画布（读节点/边/标记） | `run` |
 * | `query` | 按条件问（"有哪些图节点"） | `run` |
 * | `create` | 加节点 / 连边（改内容） | `ask` |
 * | `link` | 建立引用关系（把产物/文件引到画布上） | `ask` |
 * | `generate` | 生成式（出图/出视频，花模型的钱） | `ask` |
 */
export const CANVAS_SURFACE = {
  read: "run",
  query: "run",
  create: "ask",
  link: "ask",
  generate: "ask",
} as const;
export type CanvasSurfaceOp = keyof typeof CANVAS_SURFACE;

/**
 * 画布工具名 → surface 动作（**已登记的工具**）。
 *
 * ⚠️ 新加画布工具必须在这里登记（`canvasContract.test.ts` 会盯注册表里
 * `canvas_` 前缀的工具是否都登记了）—— 未登记的会掉进策略表的"默认只读"，
 * 那正是这张表要挡的事。
 */
export const CANVAS_TOOL_OPS: Record<string, CanvasSurfaceOp> = {
  canvas_add_node: "create",
};

/**
 * 一个画布工具在**按需确认**档下应得的判定（surface 表说的那一格）。
 *
 * @param name 工具名
 * @returns `run` / `ask`；不是画布工具（没登记）→ null
 */
export function canvasSurfaceVerdict(name: string): "run" | "ask" | null {
  const op = CANVAS_TOOL_OPS[name];
  return op ? CANVAS_SURFACE[op] : null;
}
