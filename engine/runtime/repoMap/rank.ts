import type { RefEdge } from "./graph";
import type { Symbol } from "./parse";

/**
 * PageRank（E1）：按引用关系给符号排序。
 *
 * personalization：对话里提到的文件 / 标识符权重更高（Aider 的做法：
 * chat 文件与提及标识符 ×50 的边权）。这里用更简单的一档：命中就 ×10，
 * 效果一样是"把当前话题相关的符号顶上来"。
 */

export function rankSymbols(
  graph: { nodes: Symbol[]; edges: RefEdge[] },
  opts: { chatFiles?: readonly string[]; mentioned?: readonly string[] } = {},
): Array<{ symbol: Symbol; score: number }> {
  const n = graph.nodes.length;
  if (!n) return [];
  const chatFiles = new Set((opts.chatFiles ?? []).map((f) => f.split("\\").join("/").toLowerCase()));
  const mentioned = new Set(opts.mentioned ?? []);

  const index = new Map<Symbol, number>();
  graph.nodes.forEach((symbol, i) => index.set(symbol, i));
  /*
   * ⚠️ 这里原来对每条边遍历**全部节点**找同名目标 —— 2.4 万符号 / 上百万条边时
   * 实测 167 秒（一次 `/map` 把验收卡死）。按名字建一次索引，复杂度从 O(E×N) 降回 O(E)。
   */
  const indexByName = new Map<string, number[]>();
  graph.nodes.forEach((symbol, i) => {
    const list = indexByName.get(symbol.name) ?? [];
    list.push(i);
    indexByName.set(symbol.name, list);
  });
  const outgoing: number[][] = Array.from({ length: n }, () => []);
  const incoming: number[][] = Array.from({ length: n }, () => []);
  for (const edge of graph.edges) {
    const from = index.get(edge.from);
    if (from === undefined) continue;
    for (const to of indexByName.get(edge.toName) ?? []) {
      if (to === from) continue;
      outgoing[from]!.push(to);
      incoming[to]!.push(from);
    }
  }

  const weight = graph.nodes.map((symbol) => {
    let w = 1;
    if (chatFiles.has(symbol.file.split("\\").join("/").toLowerCase())) w *= 10;
    if (mentioned.has(symbol.name)) w *= 10;
    return w;
  });
  const total = weight.reduce((a, b) => a + b, 0) || 1;

  let scores = graph.nodes.map((_, i) => weight[i]! / total);
  const damping = 0.85;
  for (let iter = 0; iter < 10; iter += 1) {
    const next = graph.nodes.map((_, i) => (1 - damping) * (weight[i]! / total));
    for (let from = 0; from < n; from += 1) {
      const outs = outgoing[from]!;
      if (!outs.length) {
        /* 悬空节点把分数均摊（否则所有分数都会漏掉） */
        const share = (damping * scores[from]!) / n;
        for (let i = 0; i < n; i += 1) next[i]! += share;
        continue;
      }
      const share = (damping * scores[from]!) / outs.length;
      for (const to of outs) next[to]! += share;
    }
    scores = next;
  }
  void incoming;
  return graph.nodes
    .map((symbol, i) => ({ symbol, score: scores[i]! }))
    .sort((a, b) => b.score - a.score);
}
