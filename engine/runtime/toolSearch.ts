/**
 * **工具搜索**（G03，2026-10-18）。
 *
 * ## 它解决什么
 *
 * 工具多到 60 个时（内置 13 + 几组连接器 + 插件），每轮请求都要把**全部 schema**
 * 塞进上下文 —— 光工具定义就能吃掉几千 token，而且选择准确率会下降（选项太多）。
 * 成熟 harness 的做法是 **deferred exposure**：先只给"核心 + 与这句话相关的"，
 * 其余仍可被搜到/被显式请求。
 *
 * ## 口径
 *
 * - **BM25**（k1=1.2, b=0.75）对 `name + description` 打分；
 * - **核心工具永远在场**（读/写/改/跑/列/搜 —— 少了它们模型连第一步都迈不出）；
 * - **只在工具数超过阈值时启用**（默认 40）：小工具集全量下发更稳，
 *   别为了"看起来先进"把 eval 的 63 条也改了行为；
 * - 搜索**一定**回退全量（匹配为空时）；宁可多给，也不能让模型找不到工具。
 */

import type { ToolEntryInput } from "./registry";

/**
 * 不参与裁剪的核心工具（无论查询是什么都在场）。
 *
 * ⚠️ P0-01/02/07：`todo_write` / `finish` / `ask_user` 也必须在场。
 *
 * 它们不是"按需检索的业务工具"，而是**协议层**：没有 `finish` 就没有完成契约，
 * 没有 `todo_write` 就没有抗压缩的进度，没有 `ask_user` 模型只能把问卷塞回正文。
 * 实测踩过：CLI 的注册表超过阈值（用户装了插件/MCP）时，这三个被 BM25 裁掉，
 * 模型在回复里写"我这边实际可用的工具里没有 todo_write 和 finish"。
 */
export const ALWAYS_TOOLS: readonly string[] = [
  "read_file",
  "read_image",
  "write_file",
  "edit_file",
  "list_files",
  "list_dir",
  "search_files",
  "run_command",
  /* B-03：后台任务的读取与停止 —— 与 run_command 同一组，漏了模型就轮询不到 */
  "job_output",
  "job_kill",
  "web_fetch",
  "todo_write",
  "finish",
  "ask_user",
];

/** 默认阈值：工具数 ≤ 这个值就全量下发。 */
export const DEFER_THRESHOLD = 40;

/** 除了核心之外，按得分再给几个。 */
export const SEARCH_LIMIT = 12;

/** BM25 参数（与方案一致）。 */
const K1 = 1.2;
const B = 0.75;

/**
 * 分词：英文按词、中文按**双字**（不做词典分词 —— 不引依赖，且对工具名/描述够用）。
 *
 * @param text 文本
 */
export function tokenizeToolText(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const word of lower.match(/[a-z0-9_]+/g) ?? []) out.push(word);
  for (const run of lower.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) out.push(run);
    else for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2));
  }
  return out;
}

/**
 * 按查询给工具打分（BM25）。
 *
 * @param entries 全部工具
 * @param query 用户这一句（或最近一轮的文本）
 * @returns 每个工具名与分数（降序；分 0 的不返回）
 */
export function rankTools(entries: readonly ToolEntryInput[], query: string): Array<{ name: string; score: number }> {
  const docs = entries.map((e) => ({ name: e.name, tokens: tokenizeToolText(`${e.name} ${e.description}`) }));
  const q = [...new Set(tokenizeToolText(query))];
  if (!q.length || !docs.length) return [];
  const avgLen = docs.reduce((sum, d) => sum + d.tokens.length, 0) / docs.length;
  const df = new Map<string, number>();
  for (const term of q) df.set(term, docs.filter((d) => d.tokens.includes(term)).length);
  const N = docs.length;

  const scored = docs.map((doc) => {
    let score = 0;
    for (const term of q) {
      const tf = doc.tokens.filter((t) => t === term).length;
      if (!tf) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const denom = tf + K1 * (1 - B + (B * doc.tokens.length) / (avgLen || 1));
      score += idf * ((tf * (K1 + 1)) / (denom || 1));
    }
    return { name: doc.name, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
}

/**
 * 这一轮该把哪些工具下发给模型。
 *
 * @param entries 注册表里的全部条目
 * @param query 用户这一轮的文本
 * @param opts.threshold 工具数不超过它就全量（默认 40）
 * @param opts.limit 相关工具最多给几个（默认 12）
 * @param opts.always 核心工具（默认 `ALWAYS_TOOLS`）
 * @returns 要注入的工具名；**空查询 / 没命中 / 工具不多** 时返回全部
 */
export function selectToolNames(
  entries: readonly ToolEntryInput[],
  query: string,
  opts: { threshold?: number; limit?: number; always?: readonly string[] } = {},
): string[] {
  const threshold = opts.threshold ?? DEFER_THRESHOLD;
  const limit = opts.limit ?? SEARCH_LIMIT;
  const always = new Set(opts.always ?? ALWAYS_TOOLS);
  const all = entries.map((e) => e.name);
  if (entries.length <= threshold) return all;

  const ranked = rankTools(entries, query);
  if (!ranked.length) return all;
  const picked = new Set<string>();
  for (const name of all) if (always.has(name)) picked.add(name);
  for (const item of ranked) {
    if (picked.size >= always.size + limit) break;
    picked.add(item.name);
  }
  return all.filter((name) => picked.has(name));
}
