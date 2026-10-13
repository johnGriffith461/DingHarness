import type { Artifact } from "./artifact";

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

  // 把画布显示出来（用户点了"打开"，就该看见它）
  const workbench = await import("./store");
  if (!workbench.useWorkbenchStore.getState().canvasOpen) {
    workbench.useWorkbenchStore.getState().toggleCanvas();
  }
  return "";
}
