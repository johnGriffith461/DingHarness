import type { CanvasDocument } from "@shared/ipc";
import type { CanvasNode } from "./types";
import type { Marker } from "./markers";

/**
 * 画布落盘的核心（2026-10-16 审计 P16 / P17 / P29 抽出来的）。
 *
 * ## 为什么从 `usePersistence` 里抽出来
 *
 * 这三条缺陷（空画布被示例图盖回来、并发保存丢最后一次编辑、崩溃回退分支永不可达）
 * 全都在"什么时候把哪一份写出去、写完记哪个数"这一层。它们原来和 React 的
 * `useEffect` / `useRef` 缠在同一个 hook 里 —— 于是**只能读源码判**，立不出会变红的用例。
 * 抽成不带 React 的模块之后，三条都能用假桥在 node 环境里跑出真行为。
 *
 * 主进程那一侧（`electron/ipc/snapshotStore.ts`）仍然是权威：原子写、版本迁移、
 * 崩溃回退都在那儿；这里只管**渲染侧该交出去什么、什么时候交**。
 */

/** 保存状态（状态栏显示）。 */
export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

/** 内容变动后多久落盘（防抖窗口）。 */
export const AUTOSAVE_DELAY_MS = 800;

/**
 * 仅提取可序列化的部分（节点里的函数、DOM 引用一律丢掉）。
 * 画布图必须可 JSON 序列化，否则宁可显式报错，也不要写出一份读不回来的快照。
 *
 * ⚠️ `confirmedRevision` 由调用方给（**不是**当前的 `revision`）—— 见 `createCanvasSaver`。
 */
export function serializeCanvas(input: {
  nodes: CanvasNode[];
  edges: unknown[];
  viewport: { x: number; y: number; zoom: number };
  revision: number;
  confirmedRevision: number;
  /** 标记层（阶段 5）：和节点一起进快照，否则重启后批注全丢。 */
  markers?: Marker[];
}): CanvasDocument {
  return {
    version: 2,
    revision: input.revision,
    confirmedRevision: input.confirmedRevision,
    updatedAt: new Date().toISOString(),
    viewport: { ...input.viewport },
    nodes: JSON.parse(JSON.stringify(input.nodes)) as unknown[],
    edges: JSON.parse(JSON.stringify(input.edges)) as unknown[],
    markers: JSON.parse(JSON.stringify(input.markers ?? [])) as unknown[],
  };
}

/**
 * 修订号合法性校验（PLAN 4.2）。
 * @param draft 待写入的修订号
 * @param persisted 已落盘的修订号
 * @returns 是否允许写入，以及被拒绝的原因
 */
export function validateRevision(
  draft: number,
  persisted: number,
): { ok: true } | { ok: false; reason: string } {
  if (!Number.isInteger(draft) || draft < 0) {
    return { ok: false, reason: `修订号必须是非负整数，收到 ${String(draft)}` };
  }
  if (draft < persisted) {
    return { ok: false, reason: `修订号不能倒退：${draft} < ${persisted}` };
  }
  return { ok: true };
}

/**
 * 载入的文档要不要**覆盖**当前画布（2026-10-16 审计 P16）。
 *
 * ## 判据为什么是"修订号 > 0 或还有节点"
 *
 * 主进程在**没有存档文件**时回的是 `emptyDocument()`（`revision: 0` / 无节点）——
 * 那是"全新安装"，该留着界面上的示例画布。
 * 而用户**自己把画布清空**过之后，存档里一定是 `revision ≥ 1`（清空这个动作本身推修订号），
 * 节点却是空的。
 *
 * 原来这里写的是 `if (doc.nodes.length > 0)` —— 两种情形被当成一种：
 * 清空过的画布**不载入**，于是示例图盖回来，而 `revisionRef` 已经跟着磁盘变成 5 之类，
 * store 里的修订号还是 0 → 之后**每一次**保存都被"修订号不能倒退"拒掉
 * （状态栏永久停在「保存失败」）。
 *
 * @param doc 主进程回的文档
 * @returns true = 用它覆盖画布
 */
export function shouldApplyLoadedDoc(doc: Pick<CanvasDocument, "revision" | "nodes">): boolean {
  if (Array.isArray(doc.nodes) && doc.nodes.length > 0) return true;
  return Number.isFinite(doc.revision) && doc.revision > 0;
}

/** 画布快照（交给 `serializeCanvas` 的那几样）。 */
export type CanvasSnapshotState = {
  nodes: CanvasNode[];
  edges: unknown[];
  viewport: { x: number; y: number; zoom: number };
  markers: Marker[];
  revision: number;
};

/**
 * 这次 store 变化**值不值得落盘**（2026-10-16 审计 P30）。
 *
 * ## 修的是什么
 *
 * 订阅侧原来只有一句 `if (state.revision === prev.revision) return;` —— 而**视口不推修订号**
 * （`setViewport` 只 `set({ viewport })`，见 `runtimeStore.ts`），于是"拖画布看别处"
 * 这一整类动作**永远不触发保存**：`serializeCanvas` 照旧把 `viewport` 写进文档，
 * 写的却永远是载入时那一份 —— 重启后视图回到老位置，用户停在的那个角落找不回来。
 *
 * ## 为什么不是"给视口也推修订号"
 *
 * 修订号是**内容**的版本（撤销栈、`confirmedRevision`、主进程"修订号不能倒退"都按它算）。
 * 平移一眼屏幕并没有改内容，把它算成新版本会让每次拖动都产生一份"新版本"，
 * 也会让"修订号"这个数失去它现在的含义。所以判据放在**持久化这一侧**：
 * 修订号变了**或**视口真的动了 → 该存。
 *
 * 视口按**数值**比（不是引用）：手势结束回到原处（`onEnd` 每次都会给一个新对象）不算变化，
 * 免得白白写一次盘。
 *
 * @param next 现在的 store 状态
 * @param prev 上一次订阅到的那份
 * @returns true = 安排一次落盘
 */
export function isPersistableChange(
  next: Pick<CanvasSnapshotState, "revision" | "viewport">,
  prev: Pick<CanvasSnapshotState, "revision" | "viewport">,
): boolean {
  if (next.revision !== prev.revision) return true;
  const a = next.viewport;
  const b = prev.viewport;
  if (!a || !b) return false;
  return a.x !== b.x || a.y !== b.y || a.zoom !== b.zoom;
}

/** 渲染侧用到的主进程画布能力（`ShellBridge.canvas` 的一个子集）。 */
export type CanvasSink = {
  save: (doc: CanvasDocument) => Promise<{ ok: boolean; error?: string }>;
  /** 确认某个修订号已经写全（主进程据此放行崩溃回退）。 */
  ack: (revision: number) => Promise<unknown>;
};

export type CanvasSaver = {
  /** 请求落盘一次。并发请求**不会互相顶掉**：排队等前一次写完再写最新那份。 */
  save: () => Promise<void>;
  /** 等所有排队的写盘做完（关窗前用）。 */
  idle: () => Promise<void>;
  /** 已落盘的修订号（从这个数往下会被主进程判"倒退"）。 */
  persisted: () => number;
  /** 已被 ack（= 写全了）的修订号。 */
  acknowledged: () => number;
  /** 载入之后对齐基线：`persisted` 是磁盘上的修订号，`acked` 是磁盘上已确认的那个。 */
  adopt: (persisted: number, acked: number) => void;
};

/**
 * 造一个画布写盘器。
 *
 * @param env.api 取主进程画布能力（没有桥时返回 undefined = 这次不写）
 * @param env.read 取当前画布快照
 * @param env.onState 保存状态变化的回调（状态栏用）
 * @param env.onError 失败原因（日志/排查用；界面另有状态栏）
 */
export function createCanvasSaver(env: {
  api: () => CanvasSink | undefined;
  read: () => CanvasSnapshotState;
  onState?: (state: SaveState) => void;
  onError?: (reason: string) => void;
}): CanvasSaver {
  let persisted = 0;
  let acked = 0;
  /** 写盘过程中又有改动 → 写完再补一次（P17：最后一次编辑不能因为"正在写"就丢）。 */
  let pending = false;
  /** 串行化：同一时刻只有一次写盘在跑。 */
  let running: Promise<void> | null = null;

  const state = (next: SaveState) => env.onState?.(next);
  const fail = (reason: string) => {
    state("error");
    env.onError?.(reason);
  };

  /** 真写一次：快照 → 校验 → save → ack。 */
  async function writeOnce(): Promise<void> {
    const api = env.api();
    if (!api) return;
    const snap = env.read();
    /*
     * ⚠️⚠️ `confirmedRevision` 写的是**上一次 ack 过的**修订号，**不是**当前修订号
     * （2026-10-16 审计 P29）。
     *
     * 原来这里是 `confirmedRevision: state.revision` —— 每一份落盘的文件都自称"已确认"，
     * 于是主进程启动时那句 `if (doc.confirmedRevision >= doc.revision) return {recovered:false}`
     * **恒成立**：崩溃回退那一段（连同那张回退提示）**永远不可达**，
     * 未确认快照永远不会被丢弃 —— 整个"未确认快照 + ack"的机制是个摆设。
     *
     * 语义上它就该是"上一版确认到哪儿"：写完 → 主进程 save → 渲染侧 ack → 才算确认。
     * 中间崩掉的话，磁盘上这份的 `confirmedRevision` 小于 `revision`，
     * 主进程下次启动就能认出来并回退。
     */
    const doc = serializeCanvas({
      nodes: snap.nodes,
      edges: snap.edges,
      viewport: snap.viewport,
      revision: snap.revision,
      confirmedRevision: acked,
      markers: snap.markers,
    });
    const check = validateRevision(doc.revision, persisted);
    if (!check.ok) {
      fail(check.reason);
      return;
    }

    state("saving");
    try {
      const result = await api.save(doc);
      if (!result.ok) {
        fail(`保存失败：${result.error ?? "原因未知"}`);
        return;
      }
      persisted = doc.revision;
      await api.ack(doc.revision);
      acked = doc.revision;
      state("saved");
    } catch (error) {
      fail(`保存异常：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function drain(): Promise<void> {
    // 写完一轮再看有没有新请求进来：有就再写一轮（快照是每轮现取的，写的是最新那份）
    do {
      pending = false;
      await writeOnce();
    } while (pending);
  }

  return {
    save: () => {
      /*
       * ⚠️ 正在写时的第二次请求**必须排队**，不能直接 return（P17）。
       * 原来 `persist()` 首行是 `if (savingRef.current) return;` ——
       * 关窗前那一下 `saveNow()` 正好撞上自动保存在飞，就**静默什么都不做**：
       * 最后一次编辑丢了，而状态栏还显示着上一次的「已保存」。
       */
      if (running) {
        pending = true;
        return running;
      }
      running = drain().finally(() => {
        running = null;
      });
      return running;
    },
    idle: () => running ?? Promise.resolve(),
    persisted: () => persisted,
    acknowledged: () => acked,
    adopt: (p, a) => {
      persisted = p;
      acked = a;
    },
  };
}
