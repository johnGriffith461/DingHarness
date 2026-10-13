import type { CanvasNode, NodeKind } from "./types";
import { NODE_KIND_META } from "./types";
import { nodeText } from "./nodeText";

/**
 * 节点引用芯片（阶段 5.4，对标原版 `canvasReferenceChip` + target-id/type/state）。
 *
 * 使用场景：在对话框里写 "@使用说明 帮我压缩成三行" —— 这句话里的 `@使用说明`
 * 就是一枚引用芯片，发送时会被还原成"这个节点的 id + 类型 + 内容摘要"，
 * 让模型知道自己被要求处理的是画布上的哪一个节点。
 *
 * 语法刻意做得**可读、可复制、可手打**：`@<节点标题>`。
 * 标题里有空格也能用 —— 匹配时按"已知节点标题前缀"去认，而不是靠空格分词，
 * 这样中文、带空格、带标点的标题都不会被切坏。
 */

/** 一枚已经解析出来的引用。 */
export type NodeReference = {
  /** 起始下标（`@` 的位置）。 */
  start: number;
  /** 结束下标（不含）。 */
  end: number;
  /** 引用的节点 id。 */
  nodeId: string;
  /** 芯片显示的文字（节点标题）。 */
  label: string;
  /** 被引用节点的类型。 */
  kind: NodeKind;
  /** 引用时的解析状态：节点还在 = ok；被删了 = broken。 */
  state: "ok" | "broken";
};

/** 节点在界面上的显示标题。 */
export function nodeLabel(node: Pick<CanvasNode, "id" | "type" | "data">): string {
  const data = node.data as Record<string, unknown>;
  const raw = data?.title ?? data?.alt;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  // 没标题时用「类型 + id 里的数字」兜底：带数字才能区分同类节点（代码2 / 代码3）
  const meta = NODE_KIND_META[node.type as NodeKind];
  const suffix = /^[A-Za-z]*(\d+)$/.exec(node.id)?.[1] ?? node.id;
  return `${meta?.label ?? node.type}${suffix}`;
}

/** 按标题找节点（标题唯一时才有意义；重名取第一个）。 */
export function findNodeByLabel(
  nodes: Array<Pick<CanvasNode, "id" | "type" | "data">>,
  label: string,
): Pick<CanvasNode, "id" | "type" | "data"> | null {
  const wanted = label.trim();
  if (!wanted) return null;
  return nodes.find((node) => nodeLabel(node) === wanted) ?? null;
}

/**
 * 从一段文本里找出所有引用。
 *
 * 匹配规则：`@` 后面跟任意字符，直到"下一个 `@` 或文末"；
 * 然后**在这个区间内挑最长的、能对上已知节点标题的前缀**。
 * 这样 `@使用说明和它的补充说明` 会优先命中标题为「使用说明和它的补充说明」的节点，
 * 而不是命中「使用说明」。
 *
 * @param text 待解析文本
 * @param nodes 当前画布上的节点
 * @param known 曾经存在过的节点（可选）。传了它，被删掉的节点引用会以
 *              `state: "broken"` 保留下来 —— 否则芯片会**无声消失**，
 *              用户只会觉得"我打的引用没了"，而不知道该节点已被删除。
 * @returns 按出现顺序排列的引用（不重叠）
 */
export function parseReferences(
  text: string,
  nodes: Array<Pick<CanvasNode, "id" | "type" | "data">>,
  known?: Array<Pick<CanvasNode, "id" | "type" | "data">>,
): NodeReference[] {
  const refs: NodeReference[] = [];
  if (!text) return refs;

  const liveIds = new Set(nodes.map((n) => n.id));
  const pick = (node: Pick<CanvasNode, "id" | "type" | "data">) => ({
    id: node.id,
    type: node.type,
    data: node.data,
    broken: !liveIds.has(node.id),
  });

  /** 候选：当前节点优先；同名时活着的那份赢。 */
  const pool = new Map<string, Pick<CanvasNode, "id" | "type" | "data"> & { broken: boolean }>();
  for (const node of known ?? []) {
    const label = nodeLabel(node);
    if (label) pool.set(label, pick(node));
  }
  for (const node of nodes) {
    const label = nodeLabel(node);
    if (label) pool.set(label, pick(node));
  }

  const titles = Array.from(pool.entries())
    .map(([label, node]) => ({ node, label }))
    // 长的排前面：这样"最长前缀优先"天然成立
    .sort((a, b) => b.label.length - a.label.length);

  let cursor = 0;
  while (cursor < text.length) {
    const at = text.indexOf("@", cursor);
    if (at === -1) break;
    const nextAt = text.indexOf("@", at + 1);
    const end = nextAt === -1 ? text.length : nextAt;
    const span = text.slice(at + 1, end);

    /**
     * 选**最长的、能对上已知标题的前缀**。
     *
     * 但光"最长"不够：画布上同时有「代码」和「代码2」时，`@代码2` 会先命中「代码」，
     * 留下一个孤零零的 `2`。所以再加一条**右边界**约束 —— 命中之后，
     * 紧跟的字符必须是"词边界"（空白、标点、下一个 `@`，或正好到末尾）。
     * 中英文标点都要算边界，否则 `@使用说明，压缩一下` 会匹配不上。
     *
     * 两条合起来的效果：
     *   · `@使用说明，压缩一下` → 命中「使用说明」（逗号是边界）
     *   · `@代码2`            → 命中「代码2」（`代码` 后面跟数字 `2`，不是边界，被排除）
     */
    const isBoundary = (ch: string | undefined): boolean => {
      if (ch === undefined) return true; // 到末尾
      if (ch === "@") return true;
      if (/\s/.test(ch)) return true;
      // 字母数字下划线算"词内"，其余（中英文标点、分隔符）算边界
      return !/[A-Za-z0-9_]/.test(ch);
    };

    const hit = titles.find((t) => {
      if (!span.startsWith(t.label)) return false;
      return isBoundary(text[at + 1 + t.label.length]);
    });

    if (hit) {
      refs.push({
        start: at,
        end: at + 1 + hit.label.length,
        nodeId: hit.node.id,
        label: hit.label,
        kind: hit.node.type as NodeKind,
        state: hit.node.broken ? "broken" : "ok",
      });
      cursor = at + 1 + hit.label.length;
      continue;
    }
    cursor = at + 1;
  }
  return refs;
}

/**
 * 把引用展开成发给模型的一小段说明。
 *
 * ## 为什么现在**要**带正文（2026-10-14 改）
 * 原来这里的规矩是"只写哪枚芯片指向哪个节点（id/类型/标题），**不重复节点正文** ——
 * 正文由选中素材那一段负责"。那条规矩在**画布上点「AI 生成」**那条路上是对的：
 * 那条路会带上 `buildSelectionContext` 的素材块，两边都写就是两份。
 *
 * 但**聊天这条路没有素材块**（`ChatSidebar.submit` 只传这一个引用块）——
 * 于是 `@某个节点 帮我压缩成三行` 发出去时，模型拿到的是一个标题，
 * 而它手上也没有"读节点内容"的工具（`electron/ipc/tools.ts` 只注册了
 * 记忆 / 定时 / 加节点 / 子智能体那几件）。结果是：用户明明引用了，模型却在猜。
 *
 * 现在按类型把正文取出来 —— 与"AI 生成"读素材用的是**同一个** `nodeText`：
 * 文本给正文、代码给围栏代码块、图表给 mermaid、导图给大纲、图片给 alt。
 * 含义很清楚：**引用即把那个卡片的内容带到模型面前**。
 *
 * ⚠️ 每个节点**截断**（默认 2000 字）：引用两三个大节点就可能把上下文顶爆，
 * 而"顶爆"的表现是莫名其妙的失败，比"少给一点内容"糟得多。
 * ⚠️ 已被删掉的引用（`broken`）不给正文，只如实说它不在了。
 * ⚠️ 将来若有哪条路同时带"素材块 + 引用块"，得**二选一**（这是当初那条规矩的真意）。
 *
 * @param refs 解析出来的引用
 * @param nodes 当前画布节点（用来取正文）。**不传就退回只写标签的旧形态** ——
 *   调用方漏传时不该炸，也不该凭空编内容。
 * @param maxChars 每个引用最多带多少字正文
 * @returns 引用块；没有引用时是空串
 */
export function referencesToPrompt(refs: NodeReference[], nodes: CanvasNode[] = [], maxChars = 2000): string {
  if (refs.length === 0) return "";
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const lines = refs.map((ref, index) => {
    const meta = NODE_KIND_META[ref.kind];
    const kind = meta ? meta.label : ref.kind;
    const broken = ref.state === "broken" ? "（该节点已不在画布上）" : "";
    const head = `- 引用${index + 1}：${kind}「${ref.label}」→ 节点 ${ref.nodeId}${broken}`;
    if (ref.state === "broken") return head;
    const node = byId.get(ref.nodeId);
    if (!node) return head;
    const body = nodeText(node).trim();
    if (!body) return head;
    return `${head}\n  内容：\n  ${body.slice(0, maxChars)}`;
  });
  return `【对话里的节点引用】\n${lines.join("\n")}`;
}

/**
 * 把文本里的引用替换成可读的展示形式（发送前不改变语义，只是给模型看）。
 */
export function expandReferences(text: string, refs: NodeReference[]): string {
  if (refs.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const ref of refs) {
    out += text.slice(cursor, ref.start);
    out += `「${ref.label}」(节点 ${ref.nodeId})`;
    cursor = ref.end;
  }
  out += text.slice(cursor);
  return out;
}

/** 一段文本里有没有引用（用于输入框的高亮提示）。 */
export function hasReference(text: string): boolean {
  return text.includes("@");
}

/**
 * 输入框里的候选节点（用户刚敲了一个 `@` 时给的下拉列表）。
 * @param query `@` 之后已经输入的部分
 * @returns 匹配的节点（最多 8 个）
 */
export function referenceCandidates(
  nodes: Array<Pick<CanvasNode, "id" | "type" | "data">>,
  query: string,
): Array<Pick<CanvasNode, "id" | "type" | "data">> {
  const q = query.trim().toLowerCase();
  const all = nodes
    .map((node) => ({ node, label: nodeLabel(node) }))
    .filter((item) => (q ? item.label.toLowerCase().includes(q) : true));
  return all.slice(0, 8).map((item) => item.node);
}
