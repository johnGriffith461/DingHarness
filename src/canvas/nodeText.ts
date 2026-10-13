import type { CanvasNode } from "./types";

/**
 * 把节点读成"给模型看的正文"（按类型取该取的那一块）。
 *
 * ## 为什么要单独一个模块
 * 这段逻辑原来藏在 `canvasGenerate.ts` 里（私有函数 `nodeText`），只有
 * "画布上选中的素材"那条路用得到它。2026-10-14 起**引用芯片也要用它** ——
 * 见 `references.ts`：聊天里 `@某个节点` 必须把那个节点的内容一起送出去，
 * 否则模型只看到一个标题，只能猜。
 *
 * 两条路共用同一份"怎么读一个节点"，就不可能出现"生成时读得到、引用时读不到"
 * 这种同功能不同命的偏差。放这里还有个好处：**纯函数**，没有 React、
 * 没有 store、没有 provider，可以直接单测。
 *
 * ⚠️ 这里只负责"读"，不负责"截断" —— 截多少由调用方定
 * （引用一条的限制与画布选素材的限制本来就不该是同一个数）。
 *
 * @param node 任意画布节点
 * @returns 该节点对模型有意义的正文；读不出内容的类型（白板、形状等）返回简短说明
 */
export function nodeText(node: CanvasNode): string {
  const data = node.data as Record<string, unknown>;
  switch (node.type) {
    case "markdown":
      return String(data.text ?? "");
    case "code":
      return "```" + String(data.lang ?? "") + "\n" + String(data.code ?? "") + "\n```";
    case "mermaid":
      return "```mermaid\n" + String(data.code ?? "") + "\n```";
    case "mindmap":
      return String(data.markdown ?? "");
    case "image":
      /* 图片节点给不了像素，但 `alt`/提示词是能读的（至少让模型知道画的什么）。 */
      return `[图片节点] ${String(data.alt ?? "")}`.trim();
    /*
     * HTML 节点：原来这条路上它**一个字都送不出去**（落到 default 的空串）——
     * 用户往画布上贴了一段 HTML 再让 AI 改，模型根本看不到源码。
     * 这是搬家时顺手补上的（同一类缺陷：有内容的节点类型在提示词里静默消失）。
     */
    case "html":
      return String(data.html ?? "");
    case "whiteboard":
      return "[白板节点：手绘草图]";
    default:
      return "";
  }
}
