/**
 * **会话事件树**（L01，2026-10-18）。
 *
 * ## 它解决什么
 *
 * `ding fork` 早就能"从这一刻分叉"，但分叉出来的会话与源会话之间**没有任何地方
 * 看得见关系** —— 用户开了三条分支之后，只看到三个并列的会话标题，不知道谁是谁的
 * 前身、各自从哪一步岔开。
 *
 * 这个模块把**会话摘要**（`{sessionId, forkedFrom}`）拼成一棵树：
 * 根是原始会话，子节点是从它分出来的副本。`forkedFrom` 是存储里已有的字段
 * （`store.append(..., { forkedFrom })`），所以**不需要改事件格式** ——
 * 分叉关系本来就是"会话级"的事实，不是"事件级"的。
 *
 * ## 三条口径
 *
 * 1. **纯逻辑**：只吃摘要数组，不碰磁盘（宿主自己读 `list()`）。
 * 2. **坏数据不炸**：`forkedFrom` 指向一个不存在的会话 → 当根处理并标 `orphan`。
 * 3. **环不成灾**：理论上不该有环（副本不能再指回自己），但磁盘数据不可信 ——
 *    遍历带 `seen` 集合，环只会让节点挂成一个孤儿子树，不会死循环。
 */

/** 会话摘要里这个模块要用的字段。 */
export type SessionNodeInput = {
  sessionId: string;
  /** 从哪一段会话分出来的（没有就是根）。 */
  forkedFrom?: string;
  title?: string;
  updatedAt?: number;
};

/** 树上的一个节点。 */
export type SessionNode = {
  sessionId: string;
  title: string;
  updatedAt?: number;
  /** 父节点（根为 null）。 */
  parentId: string | null;
  /** 从根数起第几层（根 = 0）。 */
  depth: number;
  /** `forkedFrom` 指向一个不存在的会话（当根处理，但如实标出来）。 */
  orphan: boolean;
  children: SessionNode[];
};

/** 树的形状。 */
export type SessionTree = {
  roots: SessionNode[];
  /** 全部节点（按 sessionId 取）。 */
  byId: Map<string, SessionNode>;
  /** 有环/自指的会话（如实记；它们被挂成孤儿子树）。 */
  cycles: string[];
};

/**
 * 把会话摘要拼成树。
 *
 * @param sessions 会话摘要（顺序无关）
 */
export function buildSessionTree(sessions: readonly SessionNodeInput[]): SessionTree {
  const byId = new Map<string, SessionNode>();
  const cycles: string[] = [];

  for (const s of sessions) {
    if (!s?.sessionId) continue;
    byId.set(s.sessionId, {
      sessionId: s.sessionId,
      title: (s.title ?? "").trim() || s.sessionId,
      ...(typeof s.updatedAt === "number" ? { updatedAt: s.updatedAt } : {}),
      parentId: null,
      depth: 0,
      orphan: false,
      children: [],
    });
  }

  const roots: SessionNode[] = [];
  for (const node of byId.values()) {
    const parentId = sessions.find((s) => s.sessionId === node.sessionId)?.forkedFrom;
    if (!parentId) {
      roots.push(node);
      continue;
    }
    const parent = byId.get(parentId);
    if (!parent || parentId === node.sessionId) {
      /* 父不存在 / 自己指自己：当根，但标出来（不假装它没有来历） */
      node.orphan = true;
      roots.push(node);
      if (parentId === node.sessionId) cycles.push(node.sessionId);
      continue;
    }
    node.parentId = parentId;
    parent.children.push(node);
  }

  /*
   * 算深度（顺带挡环）：从根往下走，走不到的都是环里的节点。
   * 环里的节点挂成"伪根"（`orphan`），保证它们**依然可见** —— 丢数据的做法会让
   * 用户以为分支消失了。
   */
  const reached = new Set<string>();
  const walk = (node: SessionNode, depth: number): void => {
    if (reached.has(node.sessionId)) {
      cycles.push(node.sessionId);
      return;
    }
    reached.add(node.sessionId);
    node.depth = depth;
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  for (const node of byId.values()) {
    if (reached.has(node.sessionId)) continue;
    node.orphan = true;
    node.parentId = null;
    node.depth = 0;
    cycles.push(node.sessionId);
    roots.push(node);
    walk(node, 0);
  }

  /* 稳定的展示顺序：新的在上 */
  const byTime = (a: SessionNode, b: SessionNode) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  roots.sort(byTime);
  for (const node of byId.values()) node.children.sort(byTime);

  return { roots, byId, cycles: [...new Set(cycles)] };
}

/**
 * 从根到某个节点的那条链（含它自己）。
 *
 * @param tree 树
 * @param sessionId 目标
 * @returns 节点列表；目标不在树里给空数组
 */
export function pathTo(tree: SessionTree, sessionId: string): SessionNode[] {
  const node = tree.byId.get(sessionId);
  if (!node) return [];
  const out: SessionNode[] = [node];
  let cursor = node;
  const seen = new Set<string>([node.sessionId]);
  while (cursor.parentId) {
    const parent = tree.byId.get(cursor.parentId);
    if (!parent || seen.has(parent.sessionId)) break;
    seen.add(parent.sessionId);
    out.unshift(parent);
    cursor = parent;
  }
  return out;
}

/**
 * 树 → 给人看的行（ASCII 缩进）。
 *
 * @param tree 树
 * @param opts.mark 标出这一段会话（画一个 `←`）
 */
export function treeLines(tree: SessionTree, opts: { mark?: string } = {}): string[] {
  const lines: string[] = [];
  const walk = (node: SessionNode, prefix: string, isLast: boolean): void => {
    const branch = node.depth === 0 ? "" : isLast ? "└─ " : "├─ ";
    const mark = node.sessionId === opts.mark ? "  ← 当前" : "";
    const when = node.updatedAt ? `  ${new Date(node.updatedAt).toLocaleDateString("zh-CN")}` : "";
    const orphan = node.orphan ? "  ⚠️ 来历不明（源会话不在了）" : "";
    lines.push(`${prefix}${branch}${node.title}（${node.sessionId}）${when}${orphan}${mark}`);
    const childPrefix = node.depth === 0 ? "" : `${prefix}${isLast ? "   " : "│  "}`;
    node.children.forEach((child, index) => walk(child, childPrefix, index === node.children.length - 1));
  };
  tree.roots.forEach((root, index) => walk(root, "", index === tree.roots.length - 1));
  return lines;
}

/** 同父的兄弟（给"切到另一条分支"用；不含自己）。 */
export function siblingsOf(tree: SessionTree, sessionId: string): SessionNode[] {
  const node = tree.byId.get(sessionId);
  if (!node) return [];
  const list = node.parentId ? (tree.byId.get(node.parentId)?.children ?? []) : tree.roots;
  return list.filter((n) => n.sessionId !== sessionId);
}
