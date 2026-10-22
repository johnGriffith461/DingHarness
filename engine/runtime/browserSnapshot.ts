/**
 * **ARIA 快照渲染**（B-02，2026-10-22）。
 *
 * ## 为什么换掉"注入脚本读 DOM"
 *
 * 旧做法（`shared/browserTools.ts` 的 `SNAPSHOT_SCRIPT`）有两个硬伤：
 * 1. **ref 每次从 1 重排**，并且往页面 DOM 打 `data-dsh-ref` —— 页面一重渲染，
 *    `data-dsh-ref` 可能落到别的元素上，模型点下去就点错；
 * 2. 用固定 CSS 选择器枚举"可交互元素"，**iframe 与 shadow DOM 里的东西完全看不到**。
 *
 * 现在用 CDP 的 `Accessibility.getFullAXTree`（每个 frame 各取一次），渲染成
 * Playwright 那种 YAML 文本；ref 绑定在 **`backendDOMNodeId`** 上：
 * 同一个节点在连续快照里复用同一个 ref，节点消失才失效。
 *
 * ## 这个文件是纯逻辑
 *
 * 它只做"节点列表 → 文本 + ref 表"，不碰 electron/CDP —— 于是能被单测钉住
 * （方案要求：渲染顺序、属性、ref 前缀、name 截断、generic 规则、空树）。
 */

/** CDP `Accessibility.getFullAXTree` 的一个节点（只取我们用的字段）。 */
export type AxNode = {
  nodeId?: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  backendDOMNodeId?: number;
  childIds?: string[];
  properties?: Array<{ name?: string; value?: { value?: unknown } }>;
};

/** 快照里给模型看的一个可指代元素。 */
export type SnapshotRef = { ref: string; backendNodeId: number; role: string; name: string };

/** ref 表：`backendDOMNodeId → ref`（跨快照复用）。 */
export type RefRegistry = Map<number, string>;

const NAME_LIMIT = 900;

/** 这些角色是"容器噪音"：没有名字又没有可见子节点时不渲染。 */
const GENERIC_ROLES = new Set(["generic", "none", "GenericContainer", "group"]);

/** 这些属性值得给模型看（照 Playwright 的白名单）。 */
const SHOWN_PROPS = new Set(["checked", "disabled", "expanded", "level", "selected", "pressed", "required", "readonly"]);

function textOf(part: { value?: unknown } | undefined): string {
  const v = part?.value;
  return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
}

function propsOf(node: AxNode): string[] {
  const out: string[] = [];
  for (const p of node.properties ?? []) {
    const name = typeof p?.name === "string" ? p.name : "";
    if (!SHOWN_PROPS.has(name)) continue;
    const raw = p?.value?.value;
    if (raw === true) out.push(`[${name}]`);
    else if (typeof raw === "string" || typeof raw === "number") out.push(`[${name}=${raw}]`);
    else if (raw === false) continue;
  }
  return out;
}

/**
 * 渲染一棵（或多棵）AX 树成文本，并维护 ref 的稳定性。
 *
 * @param nodes 这次拿到的全部节点（多个 frame 拼在一起；`framePrefix` 由调用方给）
 * @param registry **上一次的** ref 表（会被就地更新：新节点分配新 ref，消失的保留在表里
 *   直到下一次导航 —— 这样"页面局部刷新"不会让别的元素换号）
 * @param framePrefix 子 frame 的前缀（`f1`、`f2`…；主 frame 为空）
 * @param opts.maxChars 文本上限（超了截断并写明省略了多少节点）
 */
export function renderSnapshot(
  nodes: readonly AxNode[],
  registry: RefRegistry,
  opts: { framePrefix?: string; maxChars?: number } = {},
): { text: string; refs: SnapshotRef[]; total: number; truncated: boolean } {
  const byId = new Map<string, AxNode>();
  for (const n of nodes) if (n?.nodeId) byId.set(n.nodeId, n);

  const prefix = opts.framePrefix ?? "";
  /* 下一个 ref 序号：取现有表里最大的 +1（保证不复用别人） */
  let nextIndex = 1;
  for (const r of registry.values()) {
    const m = /(?:f\d+)?e(\d+)$/.exec(r);
    if (m) nextIndex = Math.max(nextIndex, Number(m[1]) + 1);
  }

  const refs: SnapshotRef[] = [];
  const lines: string[] = [];
  const MAX_LINES = 1200;
  let total = 0;
  let truncated = false;

  const walk = (node: AxNode, depth: number): void => {
    if (truncated) return;
    const role = textOf(node.role);
    const name = textOf(node.name);
    if (node.ignored === true || !role) {
      /* 被忽略的节点仍然要往下走（子节点常常是可访问的） */
      for (const id of node.childIds ?? []) {
        const child = byId.get(id);
        if (child) walk(child, depth);
      }
      return;
    }
    total += 1;
    const children = (node.childIds ?? []).map((id) => byId.get(id)).filter((c): c is AxNode => Boolean(c));
    const generic = GENERIC_ROLES.has(role);
    /* generic 且没有名字、又没有可见子节点 → 不渲染（纯容器噪音） */
    if (generic && !name && children.length === 0) return;

    const backend = node.backendDOMNodeId;
    let ref = "";
    if (typeof backend === "number" && backend > 0) {
      const existing = registry.get(backend);
      if (existing) ref = existing;
      else {
        ref = `${prefix}e${nextIndex}`;
        nextIndex += 1;
        registry.set(backend, ref);
      }
      refs.push({ ref, backendNodeId: backend, role, name: name.slice(0, 200) });
    }

    const safeName = name.length > NAME_LIMIT ? `${name.slice(0, NAME_LIMIT)}…` : name;
    const props = propsOf(node);
    /* 与 Playwright 的排版一致：`heading "标题" [ref=e1] [level=1]`（属性之间也有空格） */
    const head = `- ${role}${safeName ? ` ${JSON.stringify(safeName)}` : ""}${ref ? ` [ref=${ref}]` : ""}${
      props.length ? ` ${props.join(" ")}` : ""
    }`;
    lines.push(`${"  ".repeat(depth)}${head}${children.length ? ":" : ""}`);
    if (lines.length >= MAX_LINES) {
      truncated = true;
      return;
    }
    for (const child of children) walk(child, depth + 1);
  };

  /* 根：优先找 role=RootWebArea；没有就从"没有人当孩子"的节点起 */
  const childIds = new Set<string>();
  for (const n of nodes) for (const id of n.childIds ?? []) childIds.add(id);
  const roots = nodes.filter((n) => n?.nodeId && !childIds.has(n.nodeId));
  for (const root of roots) walk(root, 0);

  let text = lines.join("\n");
  const maxChars = opts.maxChars ?? 12000;
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n…（快照超过 ${maxChars} 字符，已截断；可用 browser_find 或缩小范围再看）`;
    truncated = true;
  }
  if (!text.trim()) text = "（页面没有可访问元素）";
  return { text, refs, total, truncated };
}

/** 导航后清空 ref 表（旧的 backendNodeId 在新页面上没有意义）。 */
export function clearRefs(registry: RefRegistry): void {
  registry.clear();
}
