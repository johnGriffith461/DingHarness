import type { Edge } from "@xyflow/react";
import type { Artifact } from "./artifact";
import { normalizeCanvasDoc } from "@/canvas/normalizeDoc";
import type { CanvasNode } from "@/canvas/types";
import { CLIPBOARD_MARK, planPaste } from "@/canvas/clipboard";

/**
 * 把产物**在画布里打开**（阶段 11.21）。
 *
 * ## 为什么不能甩给系统程序
 * 产物卡片上那个 ↗，实机是**打开画布面板**（`openCanvasPanel` + `canvasLayoutState`），
 * 不是"用记事本打开这个文件"。原来我在所有类型上都调 `openArtifact`，
 * 结果是：双击一个 .md 会蹦出记事本 —— 那既不是上位的行为，
 * 也不如直接显示在画布里有用（还要多关一个窗口）。
 *
 * .docx/.pptx/.xlsx 是另一回事：上位是用远端 office 页面渲染的，
 * 我是**真的生成了 Office 文件**（有意分歧，见 HANDOFF），所以那几个仍然交给系统程序。
 *
 * ## 为什么动态 import
 * 画布是重模块（React Flow + 一堆节点渲染器），工作台首页不该为它付出首屏代价。
 */

/** 这些类型能在画布里显示（其余交给系统程序）。 */
const CANVAS_KINDS = new Set(["markdown", "html", "code", "image", "canvas"]);

/**
 * 判断一个产物是否适合在画布里打开。
 *
 * @param artifact 产物
 * @returns 能在画布里显示则为 true
 */
export function opensInCanvas(artifact: Artifact): boolean {
  return CANVAS_KINDS.has(artifact.kind) && Boolean(artifact.content);
}

/**
 * 在画布里打开一个产物：按类型建对应节点，并把画布显示出来。
 *
 * @param artifact 产物
 * @returns 失败原因；成功返回空串
 */
export async function openInCanvas(artifact: Artifact): Promise<string> {
  const content = artifact.content ?? "";
  if (!content) return "这个产物没有可显示的内容";

  let store: typeof import("@/canvas/runtimeStore");
  try {
    store = await import("@/canvas/runtimeStore");
  } catch {
    return "画布模块加载失败";
  }
  /*
   * 画布没开就先开、并**等载入完成**再加节点。
   *
   * 2026-10-20（accept-canvasopen 实测）：原来是"先 addNodeAt、再 toggleCanvas" ——
   * 挂载后的 `usePersistence` 会 `loadDocument()` 覆盖整块画布，刚加的节点被冲掉，
   * 用户点「在画布中打开」看到的是原来的 6 个示例节点。与画布命令那条是同一个竞态
   * （见 `loadGate.ts`），所以用同一道闸。
   */
  const wb = await import("./store");
  if (!wb.useWorkbenchStore.getState().canvasOpen) {
    const { resetCanvasLoadGate, waitCanvasLoaded } = await import("@/canvas/loadGate");
    resetCanvasLoadGate();
    wb.useWorkbenchStore.getState().toggleCanvas();
    const loaded = await waitCanvasLoaded(15_000);
    if (!loaded) return "画布打开后 15 秒内没载入完，没有往里加节点";
  }
  const canvas = store.useRuntimeStore.getState();

  /*
   * 落点：现有节点右边再往右一点，避免**盖在已有节点上** ——
   * 每次都堆在同一个位置的话，连开两个产物就只看得见一个。
   */
  const right = canvas.nodes.reduce((max, node) => {
    const x = (node.position?.x ?? 0) + (node.width ?? 320);
    return Math.max(max, x);
  }, 0);
  const at = canvas.nodes.length === 0 ? { x: 260, y: 180 } : { x: right + 120, y: 140 };

  /*
   * ⚠️⚠️ `kind === "canvas"` 的产物要**真的进画布**（2026-10-16 审计 P267）。
   *
   * `CANVAS_KINDS` 一直把 `canvas` 算作"能在画布里显示"，而下面的类型映射只有
   * html / code / image 三档、其余一律落到 `markdown` —— 于是这类产物被建成一个
   * **文本节点，正文是那段 JSON 原文**：用户点了 ↗ 看到一坨 JSON，还以为是哪里弄错了。
   *
   * 现在：解析成画布文档（`normalizeCanvasDoc` 洗一遍，与载入/版本恢复同一条口径），
   * 用 `planPaste`（剪贴板那条已测的路）重排 id 后**追加**进当前画布 ——
   * **追加而不是覆盖**：整张覆盖是 P23 那条缺陷的形状，这里不该重犯。
   * 解析不出来就如实说（不编内容，也不静默降级成一段 JSON）。
   */
  if (artifact.kind === "canvas") {
    let payload: { nodes: CanvasNode[]; edges: Edge[] };
    try {
      const doc = normalizeCanvasDoc(JSON.parse(content));
      if (doc.nodes.length === 0) return "这段产物的内容是空画布（没有可以显示的节点）";
      payload = { nodes: doc.nodes, edges: doc.edges };
    } catch {
      return "这段产物的内容不是合法的画布 JSON，没法放进画布";
    }
    const plan = planPaste({ mark: CLIPBOARD_MARK, nodes: payload.nodes, edges: payload.edges }, canvas.nodes, at);
    if (plan.nodes.length === 0) return "";
    canvas.commitHistory();
    store.useRuntimeStore.getState().appendNodes(plan.nodes, plan.edges);
    return "";
  }

  const kind = (
    artifact.kind === "html" ? "html" : artifact.kind === "code" ? "code" : artifact.kind === "image" ? "image" : "markdown"
  ) as Parameters<typeof canvas.addNodeAt>[0];

  const node = canvas.addNodeAt(kind, at);
  const patch: Record<string, unknown> =
    kind === "html"
      ? { html: content, title: artifact.title, preview: true }
      : kind === "code"
        ? { code: content, title: artifact.title, preview: false }
        : kind === "image"
          ? { src: content.startsWith("data:") ? content : artifact.filePath ?? content, title: artifact.title }
          : { text: content, title: artifact.title, preview: true };

  store.useRuntimeStore.getState().patchNodeData(node.id, patch);
  store.useRuntimeStore.getState().selectNodes([node.id]);
  return "";
}
