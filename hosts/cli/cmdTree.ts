import { buildSessionTree, pathTo, siblingsOf, treeLines } from "../../engine/core/eventTree";
import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import type { Parsed } from "./args";

/**
 * `ding tree [会话 id] [--json]` —— **会话分支树**（L01，2026-10-18）。
 *
 * 不带参数：列出全部会话的分支树（新的在上）。
 * 带会话 id：只打印**那一条分支链**（根 → 它）+ 它的兄弟（切分支用）。
 *
 * `forkedFrom` 是存储里已有的字段（`ding fork` 会写），所以这里**只读**，
 * 不改任何日志格式。
 */

/**
 * 真正的实现（异步：要读 `store.list()`）。
 *
 * @param p 参数
 * @param dataDir 数据目录
 */
export async function runTreeCommand(p: Parsed, dataDir: string): Promise<number> {
  const store = createSqliteSessionStore(dataDir);
  try {
    const list = await store.list();
    const tree = buildSessionTree(
      list.map((s) => ({
        sessionId: s.sessionId,
        ...(s.forkedFrom ? { forkedFrom: s.forkedFrom } : {}),
        title: s.title,
        updatedAt: s.updatedAt,
      })),
    );
    const target = p.args[0];
    if (p.flags.has("json")) {
      const nodes = [...tree.byId.values()].map((n) => ({
        sessionId: n.sessionId,
        title: n.title,
        parentId: n.parentId,
        depth: n.depth,
        orphan: n.orphan,
      }));
      process.stdout.write(`${JSON.stringify({ nodes, cycles: tree.cycles }, null, 2)}\n`);
      return 0;
    }
    if (!list.length) {
      process.stdout.write("还没有任何会话。\n");
      return 0;
    }
    if (!target) {
      process.stdout.write(treeLines(tree).join("\n") + "\n");
      process.stdout.write(`\n共 ${tree.byId.size} 段会话。看某一条的分支：ding tree <会话 id>\n`);
      return 0;
    }
    if (!tree.byId.has(target)) {
      process.stderr.write(`没有这段会话：${target}\n`);
      return 1;
    }
    process.stdout.write("这条分支（根 → 它）：\n");
    for (const node of pathTo(tree, target)) {
      const mark = node.sessionId === target ? "  ← 当前" : "";
      process.stdout.write(`  ${"  ".repeat(node.depth)}${node.title}（${node.sessionId}）${mark}\n`);
    }
    const siblings = siblingsOf(tree, target);
    if (siblings.length) {
      process.stdout.write("\n同一处岔开的其它分支：\n");
      for (const node of siblings) process.stdout.write(`  · ${node.title}（${node.sessionId}）\n`);
    }
    process.stdout.write(`\n整棵树：\n${treeLines(tree, { mark: target }).join("\n")}\n`);
    return 0;
  } finally {
    store.close();
  }
}
