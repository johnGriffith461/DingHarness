import type { Symbol } from "./parse";

/**
 * 引用图（E1）：符号 ← 源码里出现的标识符。
 *
 * 不做语义解析（那要完整 TypeScript program 与模块解析，成本远大于收益）：
 * 用**标识符词边界**扫一遍，命中已知符号名就算一条边。Aider 的 repomap 也是
 * "引用图 + PageRank"这个骨架；这里少的是 tree-sitter 的高召回，边界如实写。
 */

export type RefEdge = { from: Symbol; toName: string };

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g;

export function buildGraph(
  symbols: readonly Symbol[],
  sources: ReadonlyMap<string, string>,
): { nodes: Symbol[]; edges: RefEdge[] } {
  const byName = new Map<string, Symbol[]>();
  for (const symbol of symbols) {
    const list = byName.get(symbol.name) ?? [];
    list.push(symbol);
    byName.set(symbol.name, list);
  }
  /*
   * 每个文件**只扫一次**标识符（原来每个符号都扫一遍自己的文件：24k 符号 × 几千 token，
   * 实测 6.8 秒）。扫完按文件缓存，符号阶段只做集合差。
   */
  const identsByFile = new Map<string, string[]>();
  for (const [file, source] of sources) {
    const seen = new Set<string>();
    for (const match of source.matchAll(IDENT)) {
      const name = match[0];
      if (byName.has(name)) seen.add(name);
    }
    identsByFile.set(file, [...seen]);
  }

  const edges: RefEdge[] = [];
  for (const symbol of symbols) {
    const idents = identsByFile.get(symbol.file) ?? [];
    /* 单符号最多 20 条边：24k 符号 × 全表会到 160 万条，PageRank 直接几秒 */
    let count = 0;
    for (const name of idents) {
      if (count >= 20) break;
      if (name === symbol.name) continue;
      /* 自己文件里定义的同名符号不算引用边（避免每个文件自环） */
      if (byName.get(name)?.some((s) => s.file === symbol.file)) continue;
      edges.push({ from: symbol, toName: name });
      count += 1;
    }
  }
  return { nodes: [...symbols], edges };
}
